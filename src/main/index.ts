import { app, shell, BrowserWindow, ipcMain } from "electron"
import { join } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import icon from "../../resources/icon.png?asset"
import { promises as fs } from "fs"
import { pdfToPng } from "pdf-to-png-converter"
import sharp from "sharp"
import { createWorker } from "tesseract.js"
import { tesseractCodes } from "../renderer/src/utils/languages"

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
    }
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.electron")

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on("ping", () => console.log("pong"))

  createWindow()

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// IPC handler for audiobook processing
ipcMain.handle(
  "process-audiobook",
  async (_event, { pdfBuffer, pageRange, cropSettings, language }) => {
    try {
      console.log("Processing audiobook request:", {
        pageRange,
        cropSettings,
        pdfBufferLength: pdfBuffer.length
      })

      const [startPage, endPage] = pageRange
      const pagesToProcess = endPage - startPage + 1

      console.log(`Crop settings: top=${cropSettings.top}px, bottom=${cropSettings.bottom}px`)

      const images = await pdfToPng(pdfBuffer, {
        outputFolder: "libre-lyre-temp",
        viewportScale: 2,
        outputFileMaskFunc: (pageNumber) => `page_${pageNumber}.png`,
        disableFontFace: true,
        pagesToProcess: [startPage, endPage]
      })

      const topMarginPx = cropSettings.top * 2 // times two because we scaled the image by 2
      const bottomMarginPx = cropSettings.bottom * 2 // times two because we scaled the image by 2

      const languageCode = tesseractCodes.find((l) => l.name === language)?.code || "eng"
      const worker = await createWorker(languageCode)

      let extractedText = ""

      for (const image of images) {
        const imageBuffer = image.content
        const imageHeight = image.height
        const imageWidth = image.width

        const sharpOptions = {
          left: 0,
          top: topMarginPx,
          width: Math.floor(imageWidth),
          height: Math.floor(imageHeight - topMarginPx - bottomMarginPx)
        }

        console.log("Cropping image")
        const croppedImageBuffer = await sharp(imageBuffer).extract(sharpOptions).toBuffer()

        const {
          data: { text }
        } = await worker.recognize(croppedImageBuffer)
        extractedText += text

        console.log("Extracted text from page: " + image.pageNumber, "text: " + text)
      }

      // Cleanup any words broken by line (e.g. "con- fusedly" -> "confusedly")
      // Fix hyphenated words at line breaks (e.g., "con-\nfusedly" -> "confusedly")
      const cleanedText = extractedText
        .replace(/\s+/g, " ") // Replace multiple spaces with single space
        .replace(/\n+/g, "\n") // Replace multiple newlines with single newline
        .replace(/(\w+)-\s+(\w+)/g, "$1$2") // Hyphen + space
        .replace(/(\w+)-\n(\w+)/g, "$1$2") // Hyphen + newline
        .replace(/\n/g, " ") // Replace newlines with spaces
      console.log("Cleaned text:", cleanedText)

      // Debug logging
      console.log(`Extracted text length: ${cleanedText.length} characters`)
      console.log(`First 200 characters: ${cleanedText.substring(0, 200)}...`)
      console.log(`Last 200 characters: ...${cleanedText.substring(cleanedText.length - 200)}`)
      console.log(`Pages processed: ${pagesToProcess} (from page ${startPage} to ${endPage})`)

      // Delete temp folder
      fs.rmdir("libre-lyre-temp", { recursive: true })

      return {
        success: true,
        text: cleanedText,
        pageCount: pagesToProcess
      }
    } catch (error) {
      console.error("PDF processing error:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown processing error"
      }
    }
  }
)

// IPC handler for audio buffer concatenation (no file saving required)
ipcMain.handle("concatenate-audio-buffers", async (_event, { audioData, outputFile }) => {
  try {
    console.log(`Concatenating ${audioData.length} audio buffers into ${outputFile}`)

    if (audioData.length === 0) {
      throw new Error("No audio data provided")
    }

    // Calculate total length for concatenated audio
    let totalLength = 0
    audioData.forEach((chunk: { audio: number[]; sampling_rate: number }) => {
      totalLength += chunk.audio.length
    })

    console.log(`Total audio samples: ${totalLength}`)

    // Concatenate all audio data
    const combinedAudio = new Float32Array(totalLength)
    let offset = 0

    for (const chunk of audioData) {
      const audioArray = new Float32Array(chunk.audio)
      combinedAudio.set(audioArray, offset)
      offset += audioArray.length
    }

    // Convert Float32Array to WAV buffer using a simple WAV format
    const sampleRate = audioData[0].sampling_rate
    const wavBuffer = createWavBuffer(combinedAudio, sampleRate)

    // Save to Downloads directory
    const downloadsPath = app.getPath("downloads")
    const outputPath = `${downloadsPath}/${outputFile}`
    await fs.writeFile(outputPath, wavBuffer)

    console.log(`Audio concatenation completed: ${outputPath}`)
    console.log(
      `Final audio length: ${combinedAudio.length} samples (${(combinedAudio.length / sampleRate).toFixed(1)} seconds)`
    )

    return { success: true, outputPath }
  } catch (error) {
    console.error("Audio buffer concatenation error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Audio buffer concatenation failed"
    }
  }
})

// Helper function to create WAV file buffer from Float32Array
function createWavBuffer(audioData: Float32Array, sampleRate: number): Buffer {
  const length = audioData.length
  const buffer = Buffer.alloc(44 + length * 2)

  // WAV header
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + length * 2, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(length * 2, 40)

  // Convert float32 to int16 and write to buffer
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]))
    buffer.writeInt16LE(sample * 0x7fff, 44 + i * 2)
  }

  return buffer
}
