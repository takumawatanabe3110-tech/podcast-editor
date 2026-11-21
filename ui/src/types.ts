// サーバー（engine/podcast_engine/server.py）とやり取りするデータの形。
// .podproj（project.py）と .transcript.json（transcribe.py）をそのまま写している。

export interface Source { path: string; kind: 'voice' | 'bgm' | string }
export interface TrackOffset { offset_sec: number; drift_ppm: number; method?: string }
export interface Sync { reference: string; tracks: Record<string, TrackOffset> }
export interface Voice {
  source: string; name: string; gain_db: number; pan: number; mute: boolean
  denoise: unknown; effects: unknown[]
  keyframes?: Keyframe[] // 音量カーブ（基準時刻の点、dB）。ない回もある
}
/** 基準時刻（秒）の区間。カットは「残す区間のリスト」で表す */
export interface Segment { start: number; end: number }
export interface Edit {
  position: number // 最初の区間を置く出力時刻
  segments: Segment[]
  crossfade_ms: number
  end_after_speech_sec: number | null
}
export interface Keyframe { t: number; db: number }
export type BgmAnchor = 'output_start' | 'voice_start' | 'voice_end'
export interface BgmClip {
  source: string; at: number; duration: number; offset_in: number; gain_db: number
  fade_in: number; fade_out: number; fade_in_curve: number; fade_out_curve: number
  keyframes: Keyframe[]; anchor: BgmAnchor
}
export interface Project {
  format: 'podproj'; version: number; name: string; sample_rate: number
  sources: Record<string, Source>; sync: Sync; voices: Voice[]; edit: Edit
  bgm: BgmClip[]; bgm_effects: unknown[]; master_effects: unknown[]
  output: Record<string, unknown>; corrections: Record<string, string>
  preset?: string // 作るときに使ったプリセットの名前（なければ空）
}
export interface Derived {
  output_end: number
  layout: { out_start: number; start: number; end: number }[]
  bgm: { source: string; start: number; duration: number }[]
  sources: Record<string, { duration: number; sample_rate: number }>
}
export interface ProjectResponse { name: string; project: Project; derived: Derived }

export interface Word { t0: number; t1: number; w: string; p: number; filler: boolean }
export interface Utterance {
  speaker: string; source: string; start: number; end: number
  text: string // フィラー込み（ルビ）
  script: string // フィラー抜き（台本）
  words: Word[]
}
export interface Transcript { format: 'podtranscript'; version: number; model: string; language: string; utterances: Utterance[] }

/** 波形（ファイル内の時刻で 1/rate 秒ごと。min/max は −127〜127、scale 倍すると元の値） */
export interface Peaks { rate: number; scale: number; min: number[]; max: number[] }
