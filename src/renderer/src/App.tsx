import Versions from "./components/Versions"
import electronLogo from "./assets/electron.svg"
import { Button } from "@mui/material"
import { KokoroTTS } from "kokoro-js"

function App(): React.JSX.Element {
  const ipcHandle = (): void => window.electron.ipcRenderer.send("ping")

  const generateSpeech = async (): Promise<void> => {
    const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX"
    const tts = await KokoroTTS.from_pretrained(model_id, {
      dtype: "fp32",
      device: "webgpu"
    })

    const text = "Is this really working! This is the craziest shit ever."
    const audio = await tts.generate(text, { voice: "af_heart" })
    audio.save("audio.wav")
  }

  return (
    <>
      <Button variant="contained" onClick={generateSpeech}>
        Test Speech Generation
      </Button>
      <img alt="logo" className="logo" src={electronLogo} />
      <div className="creator">Powered by electron-vite</div>
      <div className="text">
        Build an Electron app with <span className="react">React</span>
        &nbsp;and <span className="ts">TypeScript</span>
      </div>
      <p className="tip">
        Please try pressing <code>F12</code> to open the devTool
      </p>
      <div className="actions">
        <div className="action">
          <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">
            Documentation
          </a>
        </div>
        <div className="action">
          <a target="_blank" rel="noreferrer" onClick={ipcHandle}>
            Send IPC
          </a>
        </div>
      </div>
      <Versions />
    </>
  )
}

export default App
