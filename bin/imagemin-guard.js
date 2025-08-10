#!/usr/bin/env node

import { runImageminGuard } from '../src/index.js'

try {
  await runImageminGuard()
} catch (error) {
  console.error('Error running Imagemin Guard:', error.message)
  process.exit(1)
}