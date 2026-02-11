#!/usr/bin/env node

import { runImageminGuard } from '../src/index.js'

try {
  await runImageminGuard()
} catch (err) {
  console.error('Error running Image Guard:', err.message)
  process.exit(1)
}