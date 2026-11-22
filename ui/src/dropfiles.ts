// ドロップされたフォルダ・ファイルから、音声の素材を集める。フォルダの中（下の階層も）を順に見る。
const AUDIO = /\.(wav|wave|flac|aif|aiff)$/i

export interface Dropped { files: File[]; folder: string | null; skipped: string[] }

type Entry = FileSystemEntry
const isFile = (e: Entry): e is FileSystemFileEntry => e.isFile
const isDir = (e: Entry): e is FileSystemDirectoryEntry => e.isDirectory

function fileOf(e: FileSystemFileEntry): Promise<File> {
  return new Promise((res, rej) => e.file(res, rej))
}

async function readAll(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader()
  const out: Entry[] = []
  // readEntries は一度に全部を返さないことがあるので、空になるまで読む
  for (;;) {
    const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) return out
    out.push(...batch)
  }
}

async function walk(e: Entry, files: File[], skipped: string[]) {
  if (isFile(e)) {
    if (e.name.startsWith('.')) return
    if (AUDIO.test(e.name)) files.push(await fileOf(e))
    else skipped.push(e.name)
  } else if (isDir(e)) {
    if (e.name.startsWith('.')) return
    for (const c of await readAll(e)) await walk(c, files, skipped)
  }
}

export async function collectDropped(dt: DataTransfer): Promise<Dropped> {
  const files: File[] = [], skipped: string[] = []
  let folder: string | null = null
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter((e): e is Entry => !!e)
  if (entries.length) {
    for (const e of entries) {
      if (isDir(e) && !folder) folder = e.name
      await walk(e, files, skipped)
    }
  } else {
    for (const f of [...dt.files]) { if (AUDIO.test(f.name)) files.push(f); else skipped.push(f.name) }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
  return { files, folder, skipped }
}

/** フォルダ名・ファイル名から日付（8桁）を見つける。なければ null */
export function guessDate(names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    const m = n?.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/)
    if (m) {
      const [, y, mo, d] = m
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}${mo}${d}`
    }
  }
  return null
}
