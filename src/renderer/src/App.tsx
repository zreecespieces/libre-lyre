import React, { useState, useCallback } from "react"
import {
  Box,
  Button,
  Typography,
  Slider,
  Paper,
  Card,
  CardContent,
  LinearProgress,
  Alert,
  Divider,
  Stack,
  Container
} from "@mui/material"
import { Document, Page, pdfjs } from "react-pdf"
import { KokoroTTS } from "kokoro-js"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"

// Set up PDF.js worker - use local static file to avoid CORS issues
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js"

interface CropSettings {
  top: number // percentage
  bottom: number // percentage
}

interface ProcessingState {
  status: "idle" | "cropping" | "ocr" | "tts" | "complete" | "error"
  progress: number
  message: string
}

function App(): React.JSX.Element {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [pageRange, setPageRange] = useState<[number, number]>([1, 1])
  const [cropSettings, setCropSettings] = useState<CropSettings>({ top: 10, bottom: 10 })
  const [processing, setProcessing] = useState<ProcessingState>({
    status: "idle",
    progress: 0,
    message: ""
  })

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files[0] && files[0].type === "application/pdf") {
      const file = files[0]
      setPdfFile(file)

      // Convert File to ArrayBuffer for react-pdf compatibility in Electron
      const arrayBuffer = await file.arrayBuffer()
      setPdfData(arrayBuffer)

      setProcessing({ status: "idle", progress: 0, message: "" })
    }
  }, [])

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setCurrentPage(1)
    setPageRange([1, numPages])
  }, [])

  const handlePageRangeChange = useCallback((_: Event, newValue: number | number[]) => {
    if (Array.isArray(newValue)) {
      setPageRange([newValue[0], newValue[1]])
    }
  }, [])

  const handleCropChange = useCallback(
    (type: "top" | "bottom") => (_: Event, value: number | number[]) => {
      setCropSettings((prev) => ({
        ...prev,
        [type]: Array.isArray(value) ? value[0] : value
      }))
    },
    []
  )

  const goToPrevPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(1, prev - 1))
  }, [])

  const goToNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(numPages, prev + 1))
  }, [numPages])

  const generateAudiobook = async (): Promise<void> => {
    if (!pdfFile) return

    try {
      setProcessing({ status: "cropping", progress: 10, message: "Cropping PDF pages..." })

      // Convert File to ArrayBuffer for transfer to main process
      const pdfArrayBuffer = await pdfFile.arrayBuffer()
      const pdfUint8Array = new Uint8Array(pdfArrayBuffer)

      const result = await window.electron.ipcRenderer.invoke("process-audiobook", {
        pdfData: Array.from(pdfUint8Array), // Convert to regular array for transfer
        pageRange,
        cropSettings: {
          top: cropSettings.top / 100,
          bottom: cropSettings.bottom / 100
        }
      })

      if (result.success) {
        setProcessing({ status: "tts", progress: 80, message: "Generating speech..." })

        // Debug logging for TTS input
        console.log(`TTS Input text length: ${result.text.length} characters`)
        console.log(`TTS Input first 200 chars: ${result.text.substring(0, 200)}...`)
        console.log(
          `TTS Input last 200 chars: ...${result.text.substring(result.text.length - 200)}`
        )

        // Function to chunk text with strict character limits
        const chunkTextStrictly = (text: string, maxChunkSize: number = 400): string[] => {
          const chunks: string[] = []
          let position = 0

          while (position < text.length) {
            const chunkEnd = position + maxChunkSize

            // If we're at the end, take the rest
            if (chunkEnd >= text.length) {
              chunks.push(text.substring(position))
              break
            }

            // Try to break at sentence boundary first (. ! ?)
            let bestBreak = -1
            for (let i = chunkEnd; i > position + maxChunkSize * 0.5; i--) {
              if (/[.!?]/.test(text[i]) && i < text.length - 1 && /\s/.test(text[i + 1])) {
                bestBreak = i + 1
                break
              }
            }

            // If no sentence break found, try word boundary
            if (bestBreak === -1) {
              for (let i = chunkEnd; i > position + maxChunkSize * 0.7; i--) {
                if (/\s/.test(text[i])) {
                  bestBreak = i
                  break
                }
              }
            }

            // If still no break found, force break at maxChunkSize
            if (bestBreak === -1) {
              bestBreak = chunkEnd
            }

            // Extract chunk and trim whitespace
            const chunk = text.substring(position, bestBreak).trim()
            if (chunk.length > 0) {
              chunks.push(chunk)
            }

            // Move position forward, skipping any whitespace
            position = bestBreak
            while (position < text.length && /\s/.test(text[position])) {
              position++
            }
          }

          return chunks
        }

        const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX"
        const tts = await KokoroTTS.from_pretrained(model_id, {
          dtype: "fp32",
          device: "webgpu"
        })

        // Chunk the text and generate audio for each chunk
        const textChunks = chunkTextStrictly(result.text, 400)
        console.log(`Split text into ${textChunks.length} chunks`)

        // Generate audio for each chunk and keep in memory
        const audioChunks: { audio: Float32Array; sampling_rate: number }[] = []

        for (let i = 0; i < textChunks.length; i++) {
          setProcessing({
            status: "tts",
            progress: 80 + (i / textChunks.length) * 15,
            message: `Generating speech... (${i + 1}/${textChunks.length})`
          })

          console.log(
            `Generating chunk ${i + 1}/${textChunks.length} (${textChunks[i].length} chars)`
          )
          const chunkAudio = await tts.generate(textChunks[i], { voice: "af_bella" })

          // Keep audio data in memory (no file saving)
          audioChunks.push({
            audio: chunkAudio.audio,
            sampling_rate: chunkAudio.sampling_rate
          })
          console.log(`Generated chunk ${i} (${chunkAudio.audio.length} samples)`)
        }

        // Send audio data to main process for concatenation and saving
        setProcessing({ status: "tts", progress: 95, message: "Combining audio chunks..." })
        console.log(`Sending ${audioChunks.length} audio chunks to main process`)

        // Convert Float32Array to regular arrays for IPC transfer
        const audioData = audioChunks.map((chunk) => ({
          audio: Array.from(chunk.audio),
          sampling_rate: chunk.sampling_rate
        }))

        const concatenationResult = await window.electron.ipcRenderer.invoke(
          "concatenate-audio-buffers",
          {
            audioData,
            outputFile: "audiobook.wav"
          }
        )

        if (!concatenationResult.success) {
          throw new Error(concatenationResult.error || "Audio concatenation failed")
        }

        console.log(`Audio generation completed successfully: ${textChunks.length} chunks combined`)

        setProcessing({
          status: "complete",
          progress: 100,
          message: `Audiobook generated successfully! Pages ${pageRange[0]}-${pageRange[1]} processed.`
        })
      } else {
        throw new Error(result.error || "Processing failed")
      }
    } catch (error) {
      console.error("Processing failed:", error)
      setProcessing({
        status: "error",
        progress: 0,
        message: `Audiobook generation error: ${error instanceof Error ? error.message : "Unknown error"}`
      })
    }
  }

  const testSpeechGeneration = async (): Promise<void> => {
    const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX"
    const tts = await KokoroTTS.from_pretrained(model_id, {
      dtype: "fp32",
      device: "webgpu"
    })

    const text = "Is this really working! This is the craziest thing ever."
    const audio = await tts.generate(text, { voice: "af_heart" })
    await audio.save("test-audio.wav")
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4, height: "100vh", overflow: "auto" }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Libre Lyre - Audiobook Generator
      </Typography>

      <Stack spacing={3}>
        {/* PDF Upload Section */}
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              1. Upload PDF Document
            </Typography>
            <input
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              style={{ marginBottom: 16 }}
            />
            {pdfFile && (
              <Typography variant="body2" color="text.secondary">
                Selected: {pdfFile.name} ({numPages} pages)
              </Typography>
            )}
          </CardContent>
        </Card>

        {/* PDF Preview and Controls */}
        {pdfFile && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                2. Preview & Crop Settings
              </Typography>

              <Box sx={{ display: "flex", gap: 3 }}>
                {/* PDF Preview */}
                <Box sx={{ flex: 1, position: "relative" }}>
                  {numPages > 0 && (
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        mb: 2
                      }}
                    >
                      <Button
                        variant="outlined"
                        onClick={goToPrevPage}
                        disabled={currentPage <= 1}
                        size="small"
                      >
                        ← Previous
                      </Button>
                      <Typography variant="body2" sx={{ fontWeight: "bold" }}>
                        Page {currentPage} of {numPages}
                      </Typography>
                      <Button
                        variant="outlined"
                        onClick={goToNextPage}
                        disabled={currentPage >= numPages}
                        size="small"
                      >
                        Next →
                      </Button>
                    </Box>
                  )}

                  <Paper elevation={2} sx={{ p: 2, textAlign: "center" }}>
                    <Document
                      file={pdfData}
                      onLoadSuccess={onDocumentLoadSuccess}
                      loading={<div>Loading PDF...</div>}
                    >
                      <Box sx={{ position: "relative", display: "inline-block" }}>
                        <Page pageNumber={currentPage} width={400} />

                        {/* Crop Overlay */}
                        <Box
                          sx={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            height: `${cropSettings.top}%`,
                            backgroundColor: "rgba(255, 0, 0, 0.3)",
                            borderBottom: "2px solid red",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                        >
                          <Typography variant="caption" sx={{ color: "white", fontWeight: "bold" }}>
                            HEADER AREA (EXCLUDED)
                          </Typography>
                        </Box>

                        <Box
                          sx={{
                            position: "absolute",
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: `${cropSettings.bottom}%`,
                            backgroundColor: "rgba(255, 0, 0, 0.3)",
                            borderTop: "2px solid red",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                        >
                          <Typography variant="caption" sx={{ color: "white", fontWeight: "bold" }}>
                            FOOTER AREA (EXCLUDED)
                          </Typography>
                        </Box>
                      </Box>
                    </Document>
                  </Paper>
                </Box>

                {/* Controls */}
                <Box sx={{ flex: 1, minWidth: 300 }}>
                  <Stack spacing={3}>
                    {/* Page Range Selection */}
                    <Box>
                      <Typography variant="subtitle1" gutterBottom>
                        Page Range: {pageRange[0]} - {pageRange[1]}
                      </Typography>
                      <Slider
                        value={pageRange}
                        onChange={handlePageRangeChange}
                        valueLabelDisplay="auto"
                        min={1}
                        max={numPages}
                        marks
                        step={1}
                      />
                    </Box>

                    <Divider />

                    {/* Crop Controls */}
                    <Box>
                      <Typography variant="subtitle1" gutterBottom>
                        Top Margin: {cropSettings.top}%
                      </Typography>
                      <Slider
                        value={cropSettings.top}
                        onChange={handleCropChange("top")}
                        valueLabelDisplay="auto"
                        min={0}
                        max={50}
                        step={1}
                      />
                    </Box>

                    <Box>
                      <Typography variant="subtitle1" gutterBottom>
                        Bottom Margin: {cropSettings.bottom}%
                      </Typography>
                      <Slider
                        value={cropSettings.bottom}
                        onChange={handleCropChange("bottom")}
                        valueLabelDisplay="auto"
                        min={0}
                        max={50}
                        step={1}
                      />
                    </Box>
                  </Stack>
                </Box>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Processing Section */}
        {pdfFile && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                3. Generate Audiobook
              </Typography>

              <Stack spacing={2}>
                <Button
                  variant="contained"
                  size="large"
                  onClick={generateAudiobook}
                  disabled={
                    processing.status !== "idle" &&
                    processing.status !== "complete" &&
                    processing.status !== "error"
                  }
                  sx={{ alignSelf: "flex-start" }}
                >
                  {processing.status === "idle" ||
                  processing.status === "complete" ||
                  processing.status === "error"
                    ? "Generate Audiobook"
                    : "Processing..."}
                </Button>

                {processing.status !== "idle" && (
                  <Box>
                    <LinearProgress
                      variant="determinate"
                      value={processing.progress}
                      sx={{ mb: 1 }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {processing.message}
                    </Typography>
                  </Box>
                )}

                {processing.status === "complete" && (
                  <Alert severity="success">{processing.message}</Alert>
                )}

                {processing.status === "error" && (
                  <Alert severity="error">{processing.message}</Alert>
                )}
              </Stack>
            </CardContent>
          </Card>
        )}

        {/* Test Section */}
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Test Speech Generation
            </Typography>
            <Button variant="outlined" onClick={testSpeechGeneration}>
              Test TTS
            </Button>
          </CardContent>
        </Card>
      </Stack>
    </Container>
  )
}

export default App
