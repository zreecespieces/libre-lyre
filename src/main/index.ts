import { app, shell, BrowserWindow, ipcMain } from "electron"
import { join } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import icon from "../../resources/icon.png?asset"
import * as fs from "fs/promises"

import { PDFDocument } from "pdf-lib"

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

// IPC handler for audiobook processing
ipcMain.handle("process-audiobook", async (_event, { pdfData, pageRange, cropSettings }) => {
  try {
    console.log("Processing audiobook request:", {
      pageRange,
      cropSettings,
      pdfDataLength: pdfData.length
    })

    // Convert array back to Uint8Array
    const pdfBytes = new Uint8Array(pdfData)
    const pdfDoc = await PDFDocument.load(pdfBytes)

    const [startPage, endPage] = pageRange
    const pagesToProcess = endPage - startPage + 1

    // Create a new PDF with selected pages and cropping
    const croppedPdf = await PDFDocument.create()

    for (let i = startPage - 1; i < endPage; i++) {
      if (i >= pdfDoc.getPageCount()) break

      const [copiedPage] = await croppedPdf.copyPages(pdfDoc, [i])
      const { width, height } = copiedPage.getSize()

      // Apply cropping based on settings
      const topCrop = height * cropSettings.top
      const bottomCrop = height * cropSettings.bottom

      copiedPage.setCropBox(0, bottomCrop, width, height - topCrop)

      croppedPdf.addPage(copiedPage)
    }

    // Save cropped PDF to temporary file
    const croppedPdfBytes = await croppedPdf.save()
    const tempPdfPath = join(__dirname, `temp-${Date.now()}.cropped.pdf`)
    await fs.writeFile(tempPdfPath, croppedPdfBytes)

    // Dynamically import scribe.js-ocr (ESM module with top-level await)
    const { default: scribe } = await import("scribe.js-ocr")

    // Initialize scribe.js for OCR
    await scribe.init({ ocr: true, font: true })

    // Extract text directly from the cropped PDF using scribe.js
    const extractedText = await scribe.extractText([tempPdfPath])

    // Debug logging
    console.log(`Extracted text length: ${extractedText.length} characters`)
    console.log(`First 200 characters: ${extractedText.substring(0, 200)}...`)
    console.log(`Last 200 characters: ...${extractedText.substring(extractedText.length - 200)}`)
    console.log(`Pages processed: ${pagesToProcess} (from page ${startPage} to ${endPage})`)

    // Clean up temporary file
    await fs.unlink(tempPdfPath)

    return {
      success: true,
      text: extractedText,
      pageCount: pagesToProcess
    }
  } catch (error) {
    console.error("PDF processing error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown processing error"
    }
  }
})

// IPC handler for audio concatenation
ipcMain.handle("concatenate-audio", async (_event, { audioFiles, outputFile }) => {
  try {
    console.log(`Concatenating ${audioFiles.length} audio files into ${outputFile}`)

    // Simple concatenation by reading and combining audio data
    const audioBuffers: Buffer[] = []

    for (const audioFile of audioFiles) {
      try {
        const audioData = await fs.readFile(audioFile)
        audioBuffers.push(audioData)

        // Clean up individual chunk file
        await fs.unlink(audioFile)
      } catch (fileError) {
        console.warn(`Could not read/delete audio file ${audioFile}:`, fileError)
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error("No valid audio files found")
    }

    // For WAV files, we need to combine them properly
    // This is a simple approach - for production, consider using ffmpeg
    if (audioBuffers.length === 1) {
      // Single file, just rename it
      await fs.writeFile(outputFile, audioBuffers[0])
    } else {
      // Multiple files - simple concatenation (this may not work perfectly for WAV)
      // For now, just use the first file as the base
      console.warn(
        "Simple audio concatenation may not work perfectly - consider implementing ffmpeg"
      )
      const combinedBuffer = Buffer.concat(audioBuffers)
      await fs.writeFile(outputFile, combinedBuffer)
    }

    console.log(`Audio concatenation completed: ${outputFile}`)
    return { success: true }
  } catch (error) {
    console.error("Audio concatenation error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Audio concatenation failed"
    }
  }
})

// IPC handler for getting Downloads directory path
ipcMain.handle("get-downloads-path", () => {
  return app.getPath("downloads")
})

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
