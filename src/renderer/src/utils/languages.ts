interface Language {
  name: string
  code: string
  flag: string
}

export enum SupportedLanguages {
  English = "English",
  Spanish = "Spanish",
  French = "French",
  Hindi = "Hindi",
  Italian = "Italian",
  Japanese = "Japanese",
  Portuguese = "Portuguese",
  Chinese = "Chinese"
}

export const kokoroCodes: Language[] = [
  { name: SupportedLanguages.English, code: "a", flag: "🇺🇸" },
  { name: SupportedLanguages.Spanish, code: "e", flag: "🇪🇸" },
  { name: SupportedLanguages.French, code: "f", flag: "🇫🇷" },
  { name: SupportedLanguages.Hindi, code: "h", flag: "🇮🇳" },
  { name: SupportedLanguages.Italian, code: "i", flag: "🇮🇹" },
  { name: SupportedLanguages.Japanese, code: "j", flag: "🇯🇵" },
  { name: SupportedLanguages.Portuguese, code: "p", flag: "🇧🇷" },
  { name: SupportedLanguages.Chinese, code: "z", flag: "🇨🇳" }
]

export const tesseractCodes: Language[] = [
  { name: SupportedLanguages.English, code: "eng", flag: "🇺🇸" },
  { name: SupportedLanguages.Spanish, code: "spa", flag: "🇪🇸" },
  { name: SupportedLanguages.French, code: "fra", flag: "🇫🇷" },
  { name: SupportedLanguages.Hindi, code: "hin", flag: "🇮🇳" },
  { name: SupportedLanguages.Italian, code: "ita", flag: "🇮🇹" },
  { name: SupportedLanguages.Japanese, code: "jpn", flag: "🇯🇵" },
  { name: SupportedLanguages.Portuguese, code: "por", flag: "🇧🇷" },
  { name: SupportedLanguages.Chinese, code: "chi-sim", flag: "🇨🇳" }
]
