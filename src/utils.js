// This file, which had been forked from imagemin-merlin, was modified for imagemin-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { styleText } from 'node:util'

const logMessage = (message, dry, color = 'yellow', quiet = false) => {
  if (quiet) return
  const prefix = dry ? 'Dry run: ' : ''
  console.info(styleText(color, `${prefix}${message}`))
}

// Retry file operations to handle file locking issues
const retryFileOperation = async (operation, maxRetries = 5, delayMs = 100) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation()
    } catch (error) {
      if ((error.code === 'EPERM' || error.code === 'UNKNOWN') && i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)))
      } else {
        throw error
      }
    }
  }
}

const compression = async (filename, dry, quiet = false) => {
  const filenameBackup = `${filename}.bak`
  const fileSizeBefore = await size(filename)
  // Track whether original file was successfully replaced
  let replacementSucceeded = false

  if (fileSizeBefore === 0) {
    logMessage(`Skipped ${filename} (${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  const maxFileSize = 100 * 1024 * 1024 // 100 MB

  if (fileSizeBefore > maxFileSize) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry, 'yellow', quiet)
    return 0
  }

  // Place temp file next to the original to maximize same-device atomic rename
  const tempFilePath = path.join(
    path.dirname(filename),
    `.imagemin-guard-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(filename)}`
  )

  // Track whether the temporary file has been “consumed” (renamed into place or explicitly deleted after copy)
  let tempConsumed = false

  try {
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ext) {
      throw new Error(`Cannot determine file type for ${filename}—no extension found`)
    }

    const outputFormat = ext === 'jpg' ? 'jpeg' : ext // sharp uses “jpeg” instead of “jpg”

    // Compression configuration for each format
    const formatConfigs = {
      png: {
        options: { pages: -1 },
        settings: { animated: true, compressionLevel: 9, quality: 100 } // Still waiting for APNG support though (`animated` doesn’t seem to have an effect), https://github.com/lovell/sharp/issues/2375
      },
      gif: {
        options: { pages: -1 },
        settings: {
          reuse: true,               // Preserve original palette for lossless quality (default)
          effort: 10,                // Maximum compression effort
          dither: 0,                 // No dithering = lossless quality
          interFrameMaxError: 0,     // No transparency errors = lossless (default)
          interPaletteMaxError: 0,   // Perfect palette match = lossless
          colors: 256                // Full palette available (default)
        }
      },
      webp: {
        options: { pages: -1 },
        settings: { animated: true, lossless: true }
      },
      avif: {
        options: {},
        settings: { effort: 5, lossless: true } // Temporarily specifying effort, too, as per https://github.com/lovell/sharp/issues/4370#issuecomment-2798848572
      }
    }

    // Apply format-specific compression or use default
    const config = formatConfigs[outputFormat]
    if (config) {
      await sharp(filename, config.options)
        .toFormat(outputFormat, config.settings)
        .toFile(tempFilePath)
    } else {
      // Fallback for any other supported formats (like JPG)
      await sharp(filename)
        .toFormat(outputFormat, { quality: 100 })
        .toFile(tempFilePath)
    }

    const fileSizeAfter = await size(tempFilePath)

    let color = 'white'
    let status = 'Skipped'
    let details = 'already compressed'

    if (fileSizeAfter < fileSizeBefore) {
      color = 'green'
      status = 'Compressed'
      details = `${sizeReadable(fileSizeBefore)} → ${sizeReadable(fileSizeAfter)}`
      if (!dry) {
        // Only now create a backup and replace the original
        await retryFileOperation(() => fs.promises.copyFile(filename, filenameBackup))
        // Prefer atomic rename when possible
        try {
          await retryFileOperation(() => fs.promises.rename(tempFilePath, filename))
          // Temp file was renamed (consumed)
          tempConsumed = true
          replacementSucceeded = true
        } catch {
          // Fallback to copy when rename across devices isn’t possible
          await retryFileOperation(() => fs.promises.copyFile(tempFilePath, filename))
          await retryFileOperation(() => fs.promises.unlink(tempFilePath))
          // Temp file explicitly removed after copy
          tempConsumed = true
          replacementSucceeded = true
        }
      }
    } else if (fileSizeAfter > fileSizeBefore) {
      color = 'blue'
      status = 'Skipped'
      details = 'already compressed more aggressively'
    }

    logMessage(`${status} ${filename} (${details})`, dry, color, quiet)

    if (dry) {
      await retryFileOperation(() => fs.promises.unlink(tempFilePath))
      return 0
    }

    // Clean up temp file only when it wasn’t consumed
    if (!tempConsumed) {
      try {
        await retryFileOperation(() => fs.promises.unlink(tempFilePath))
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }

    if (fileSizeAfter === 0) {
      console.error(styleText('red', `Error compressing ${filename}: Compressed file size is 0`))
    }

    return fileSizeAfter < fileSizeBefore ? fileSizeBefore - fileSizeAfter : 0

  } catch (error) {

    // Check if this is a file corruption error
    if (error.message && (
      error.message.includes('corrupt header') ||
      error.message.includes('Unexpected end of') ||
      error.message.includes('Invalid') ||
      error.message.includes('gifload:') ||
      error.message.includes('pngload:') ||
      error.message.includes('jpegload:')
    )) {
      logMessage(`Skipped ${filename} (corrupt file)`, dry, 'yellow', quiet)
    } else {
      console.error(styleText('red', `Error compressing ${filename}:`), error)
    }
    return 0

  } finally {

    // If backup created (i.e., only in improvement path), try to remove it
    if (!dry && replacementSucceeded) {
      try {
        await retryFileOperation(() => fs.promises.unlink(filenameBackup))
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(styleText('yellow', `Failed to delete backup file ${filenameBackup}:`), error)
        }
      }
    }

  }
}

const size = async (file) => {
  const stats = await fs.promises.stat(file)
  return stats.size
}

const sizeReadable = (size) => `${(size / 1024).toFixed(2)} KB`

export const utils = { compression, sizeReadable }