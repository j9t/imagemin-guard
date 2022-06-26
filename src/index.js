import rimraf from 'rimraf'
import find from 'find'
import sgf from 'staged-git-files'
import { utils } from './utils.js'
import cwd from 'cwd'
import _yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const yargs = _yargs(hideBin(process.argv));

(async () => {
  const argv = await yargs
    .argv

  // Test
  // console.log(argv)

  if(argv.dry){
    rimraf.sync('/tmp/imagemin-guard');
  }

  let ignorePaths = []

  if(argv.ignore){
    ignorePaths = argv.ignore.split(',')
  }

  // Search for staged files
  if(argv.staged){
    sgf('A', async function(err, results){
      if(err){
        return console.error(err)
      }

      let didRun = false

      let filteredResults = results
        .filter(result => result.filename.match(regex))

      ignorePaths.forEach(ignorePath => {
        filteredResults = filteredResults
          .filter(result => !result.filename.match(new RegExp(ignorePath)))
      })

      for (let index = 0; index < filteredResults.length; index++) {
        const result = filteredResults[index];
        didRun = true
        savedKB += await utils.crushing(result.filename, argv.dry)
      }

      closingNote(didRun)
    })
  } else {
    let folder = cwd()

    if(argv.folder){
      folder = argv.folder
    }

    let files = find.fileSync(regex, folder)
    let didRun = false

    ignorePaths.forEach(ignorePath => {
      files = files
        .filter(file => !file.match(new RegExp(ignorePath)))
    })

    for (let index = 0; index < files.length; index++) {
      const file = files[index]

      if(!file.match(/node_modules\//)){
        didRun = true
        savedKB += await utils.crushing(file, argv.dry)
      }
    }

    closingNote(didRun)
  }
})();

// Files to be crushed
const regex = new RegExp(/\.avif|\.gif|\.jpeg|\.jpg|\.png|\.webp$/)
console.log(`(Search pattern: ${regex})\n`)

let savedKB = 0

const closingNote = (didRun) => {
  if(didRun){
    console.info(`\n🎉 You saved ${utils.sizeHuman(savedKB)}.`)
  } else {
    console.info('\nThere were no images found to crush ¯\\_(ツ)_/¯ See you next time.')
  }
}