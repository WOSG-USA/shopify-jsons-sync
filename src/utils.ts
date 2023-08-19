import {create} from '@actions/glob'
import {readFile, writeFile} from 'fs/promises'
import {existsSync} from 'fs'
import deepmerge from 'deepmerge'
import {exec} from '@actions/exec'
import {cp, rmRF} from '@actions/io'
import {debug, error as errorLog} from '@actions/core'
import {
  ShopifySettingsOrTemplateJSON,
  ISyncLocalJSONWithRemoteJSONForStore
} from './types.d'

export const EXEC_OPTIONS = {
  listeners: {
    stdout: (data: Buffer) => {
      debug(data.toString())
    },
    stderr: (data: Buffer) => {
      errorLog(data.toString())
    }
  }
}

export const fetchFiles = async (pattern: string): Promise<string[]> => {
  const globber = await create(pattern)
  const files = await globber.glob()
  return files
}

const fetchLocalFileForRemoteFile = async (
  remoteFile: string
): Promise<string> => {
  return remoteFile.replace('remote/', './')
}

export const readJsonFile = async (
  file: string
): Promise<ShopifySettingsOrTemplateJSON> => {
  if (!existsSync(file)) {
    return {} // Return empty object if file doesn't exist
  }
  const buffer = await readFile(file)
  return JSON.parse(buffer.toString())
}

export const cleanRemoteFiles = async (): Promise<void> => {
  try {
    rmRF('remote')
  } catch (error) {
    if (error instanceof Error) debug(error.message)
  }
}

export const sendFilesWithPathToShopify = async (
  files: string[],
  {targetThemeId, store, password}: ISyncLocalJSONWithRemoteJSONForStore
): Promise<string[]> => {
  const pushOnlyCommand = files
    .map(file => `--only=${file.replace('./', '')}`)
    .join(' ')

  for (const file of files) {
    const destination = `remote/new/${file.replace('./', '')}`
    await cp(file, destination, {
      recursive: true,
      force: true
    })
  }

  await exec(
    'shopify theme',
    [
      'push',
      pushOnlyCommand,
      '--theme',
      targetThemeId,
      '--store',
      store,
      '--password',
      password,
      '--path',
      'remote/new'
    ],
    EXEC_OPTIONS
  )

  return files
}

// Go throgh all keys in the object and a key which has disabled: true, remove it from the object
export const removeDisabledKeys = (
  obj: ShopifySettingsOrTemplateJSON
): ShopifySettingsOrTemplateJSON => {
  const newObj = {...obj}
  for (const key in obj) {
    if (newObj[key]?.hasOwnProperty('disabled')) {
      delete newObj[key]
    }
  }
  return newObj
}

export const syncLocaleAndSettingsJSON = async (): Promise<string[]> => {
  const remoteFiles = await fetchFiles('remote/{locales,config}/*.json')
  const localFilesToPush: string[] = []
  for (const file of remoteFiles) {
    // Read JSON for Remote File
    const remoteFile = await readJsonFile(file)

    // Get Local Version of File Path
    const localFileRef = await fetchLocalFileForRemoteFile(file)

    // Read JSON for Local File
    const localFile = await readJsonFile(localFileRef)

    // Merge Local and Remote Files with Remote as Primary
    const mergedFile = deepmerge(localFile, remoteFile, {
      arrayMerge: (_, sourceArray) => sourceArray,
      customMerge: key => {
        if (key === 'blocks') {
          return (_, newBlock) => {
            return removeDisabledKeys(newBlock)
          }
        }
      }
    })

    // Write Merged File to Local File
    await writeFile(localFileRef, JSON.stringify(mergedFile, null, 2))
    localFilesToPush.push(localFileRef)
  }

  return localFilesToPush
}

export const getNewTemplatesToRemote = async (): Promise<string[]> => {
  const remoteTemplateFilesNames = (
    (await fetchFiles('remote/templates/**/*.json')) || []
  ).map(file => file.replace('remote/', ''))

  const localTemplateFiles = await fetchFiles('./templates/**/*.json')
  const localeFilesToMove = localTemplateFiles.filter(
    file => !remoteTemplateFilesNames.includes(file)
  )

  return localeFilesToMove
}