// This file, which had been forked from imagemin-merlin, was modified for imagemin-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { execFile } from 'child_process'
import fs from 'fs'
import gifsicle from 'gifsicle'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { styleText } from 'node:util'
import util from 'util'

const logMessage = (message, dry, color = 'yellow') => {
  const prefix = dry ? 'Dry run: ' : ''
  console.info(styleText(color, `${prefix}${message}`))
}

const compression = async (filename, dry) => {
  const filenameBackup = `${filename}.bak`
  try {
    await fs.promises.copyFile(filename, filenameBackup)
  } catch (error) {
    console.error(styleText('red', `Error creating backup for ${filename}:`), error)
    return 0
  }

  const fileSizeBefore = await size(filename)

  if (fileSizeBefore === 0) {
    logMessage(`Skipped ${filename} (${sizeReadable(fileSizeBefore)})`, dry)
    return 0
  }

  const maxFileSize = 100 * 1024 * 1024 // 100 MB

  if (fileSizeBefore > maxFileSize) {
    logMessage(`Skipped ${filename} (file too large: ${sizeReadable(fileSizeBefore)})`, dry)
    return 0
  }

  const tempFilePath = path.join(os.tmpdir(), path.basename(filename))

  try {
    const ext = path.extname(filename).slice(1).toLowerCase()
    if (!ext) {
      throw new Error(`Cannot determine file type for ${filename}—no extension found`)
    }

    const outputFormat = ext === 'jpg' ? 'jpeg' : ext // sharp uses “jpeg” instead of “jpg”

    // @@ Refactor for better maintainability and configurability
    if (outputFormat === 'png') {
      await sharp(filename)
        .png({ compressionLevel: 9, quality: 100 })
        .toFile(tempFilePath)
    } else if (outputFormat === 'gif') {
      const execFileAsync = util.promisify(execFile)
      try {
        await execFileAsync(gifsicle, ['-O3', filename, '-o', tempFilePath], { stdio: ['ignore', 'ignore', 'ignore'] })
      } catch (err) {
        logMessage(`Skipped ${filename} (appears corrupt)`, dry)
        return 0
      }
    } else if (outputFormat === 'webp') {
      await sharp(filename)
        .webp({ lossless: true })
        .toFile(tempFilePath)
    } else if (outputFormat === 'avif') {
      await sharp(filename)
        // Temporarily specifying effort, too, as per https://github.com/lovell/sharp/issues/4370#issuecomment-2798848572
        .avif({ effort: 5, lossless: true })
        .toFile(tempFilePath)
    } else {
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
        await fs.promises.copyFile(tempFilePath, filename)
      }
    } else if (fileSizeAfter > fileSizeBefore) {
      color = 'blue'
      status = 'Skipped'
      details = 'already compressed more aggressively'
    }

    logMessage(`${status} ${filename} (${details})`, dry, color)

    if (dry) {
      fs.unlinkSync(tempFilePath)
      return 0
    }

    await fs.promises.unlink(tempFilePath)

    if (fileSizeAfter === 0) {
      console.error(styleText('red', `Error compressing ${filename}: Compressed file size is 0`))
    }

    return fileSizeAfter < fileSizeBefore ? fileSizeBefore - fileSizeAfter : 0

  } catch (error) {

    console.error(styleText('red', `Error compressing ${filename}:`), error)
    await fs.promises.rename(filenameBackup, filename)
    return 0

  } finally {

    try {
      await fs.promises.unlink(filenameBackup)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(styleText('yellow', `Failed to delete backup file ${filenameBackup}:`), error)
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