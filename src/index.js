// This file, which had been forked from imagemin-merlin, was modified for imagemin-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { globby } from 'globby'
import simpleGit from 'simple-git'
import { parseArgs, styleText } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { utils } from './utils.js'

// Files to be compressed
export const fileTypes = ['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'];

export async function runImageminGuard() {
  const options = {
    dry: { type: 'boolean', default: false },
    ignore: { type: 'string', multiple: false, default: '' },
    staged: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
  const { values: argv } = parseArgs({ options })

  // Share status
  const summary = (run) => {
    if (run) {
      console.info(styleText(['bold'], `\nDefensive base compression completed. You saved ${utils.sizeReadable(savedKB)}.`))
    } else {
      console.info(styleText(['bold'], 'There were no images to compress.'))
    }
  }

  console.log(`(Search pattern: ${fileTypes.join(', ')})\n`)

  let savedKB = 0

  // Tiny in-house concurrency limiter
  const createLimiter = (concurrency) => {
    let active = 0
    const queue = []
    const next = () => {
      if (active >= concurrency || queue.length === 0) return
      active++
      const { fn, resolve, reject } = queue.shift()
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--
          next()
        })
    }
    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
  }

  const compress = async (files, dry) => {
    if (files.length === 0) {
      summary(false)
      return
    }

    const desiredFileConcurrency = Math.min(os.cpus().length, 4)
    // Tune libvips threads to avoid oversubscription
    const perTaskThreads = Math.max(1, Math.floor(os.cpus().length / Math.max(1, desiredFileConcurrency)))
    try {
      sharp.concurrency(perTaskThreads)
    } catch {
      // Best-effort; ignore if not supported
    }

    const limit = createLimiter(desiredFileConcurrency)
    const tasks = files.map(file => limit(() => utils.compression(file, dry, argv.quiet)))
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'fulfilled' && typeof r.value === 'number') {
        savedKB += r.value
      }
    }

    summary(true)
  }

  const getFilePattern = (ignore) => {
    const patterns = []

    fileTypes.forEach((fileType) => {
      patterns.push(`**/*.${fileType}`, `**/*.${fileType.toUpperCase()}`)
    })

    if (ignore) {
      const ignorePaths = ignore.split(',')
      ignorePaths.forEach((path) => {
        patterns.push(`!${path}`)
      })
    }

    return patterns
  }

  const findFiles = async (patterns, options = {}) => {
    return globby(patterns, { gitignore: true, ...options })
  }

  const patterns = getFilePattern(argv.ignore)
  let files = []
  let compressionFiles = []

  // Search for staged files
  if (argv.staged) {
    const git = simpleGit()
    try {
      // Get staged file paths directly from Git
      const diffOutput = await git.raw(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'])
      const stagedFiles = diffOutput.split('\n').map(s => s.trim()).filter(Boolean)
      // Filter by allowed extensions
      const allowedExts = new Set(fileTypes)
      const byExt = stagedFiles.filter(f => allowedExts.has(path.extname(f).slice(1).toLowerCase()))
      // Apply `--ignore` filters if present
      const ignore = (argv.ignore || '').split(',').map(s => s.trim()).filter(Boolean)
      compressionFiles = byExt.filter(f => {
        // Handle simple `!path` style ignores as provided
        return !ignore.some(ig => ig && (f === ig.replace(/^!/, '') || f.startsWith(ig.replace(/^!/, '').replace(/\*$|\/$/, ''))))
      })
      await compress(compressionFiles, argv.dry)
    } catch (error) {
      console.error(error)
    }
  } else {
    files = await findFiles(patterns)
    compressionFiles = files
    await compress(compressionFiles, argv.dry)
  }
}