// Мост между интерфейсом и главным процессом: только перечисленные вызовы, без доступа к Node.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, RunEvent } from '../shared/types'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
const env = ipcRenderer.sendSync('env') as { platform: string; userName: string; version: string }

const api: Api = {
  settings: { get: call('settings:get'), set: call('settings:set') } as Api['settings'],
  models: call('models') as Api['models'],
  balance: call('balance') as Api['balance'],
  videoQuote: call('video:quote') as Api['videoQuote'],
  projects: {
    list: call('projects:list'), default: call('projects:default'), get: call('projects:get'),
    create: call('projects:create'), save: call('projects:save'), remove: call('projects:remove'),
    knowledge: call('projects:knowledge'), addFiles: call('projects:addFiles'),
    removeFile: call('projects:removeFile'), pickFolder: call('projects:pickFolder'),
  } as Api['projects'],
  chats: {
    recent: call('chats:recent'), list: call('chats:list'), load: call('chats:load'), create: call('chats:create'),
    rename: call('chats:rename'), remove: call('chats:remove'), undo: call('chats:undo'),
    switchAlt: call('chats:switchAlt'), search: call('chats:search'), changes: call('chats:changes'), diff: call('chats:diff'),
  } as Api['chats'],
  attach: {
    pick: call('attach:pick'), paths: call('attach:paths'), data: call('attach:data'),
    pathFor: (file: File) => webUtils.getPathForFile(file),
  } as Api['attach'],
  run: {
    send: call('run:send'), stop: call('run:stop'), active: call('run:active'), approve: call('run:approve'),
    onEvent: (cb: (e: RunEvent) => void) => {
      const fn = (_: unknown, e: RunEvent) => cb(e)
      ipcRenderer.on('run:event', fn)
      return () => ipcRenderer.removeListener('run:event', fn)
    },
  } as Api['run'],
  jobs: {
    list: call('jobs:list'), log: call('jobs:log'), stop: call('jobs:stop'), clear: call('jobs:clear'),
    onChange: (cb: () => void) => {
      const fn = () => cb()
      ipcRenderer.on('jobs:changed', fn)
      return () => ipcRenderer.removeListener('jobs:changed', fn)
    },
  } as Api['jobs'],
  secrets: { list: call('secrets:list'), set: call('secrets:set'), remove: call('secrets:remove'), available: call('secrets:available') } as Api['secrets'],
  servers: { test: call('servers:test') } as Api['servers'],
  files: { read: call('files:read'), mtime: call('files:mtime'), artifact: call('files:artifact') } as Api['files'],
  voice: { speak: call('voice:speak'), transcribe: call('voice:transcribe'), voices: call('voice:voices'), models: call('voice:models') } as Api['voice'],
  spend: call('spend') as Api['spend'],
  install: call('install') as Api['install'],
  memory: { list: call('memory:list'), add: call('memory:add'), update: call('memory:update'), remove: call('memory:remove') } as Api['memory'],
  mcp: { status: call('mcp:status'), test: call('mcp:test') } as Api['mcp'],
  git: { info: call('git:info'), init: call('git:init'), merge: call('git:merge'), push: call('git:push') } as Api['git'],
  telegram: { status: call('telegram:status'), setToken: call('telegram:setToken'), unlink: call('telegram:unlink') } as Api['telegram'],
  schedules: { run: call('schedules:run') } as Api['schedules'],
  term: {
    create: call('term:create') as Api['term']['create'],
    write: (id, d) => ipcRenderer.send('term:write', id, d),
    resize: (id, c, r) => ipcRenderer.send('term:resize', id, c, r),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (cb) => {
      const fn = (_: unknown, id: string, d: string) => cb(id, d)
      ipcRenderer.on('term:data', fn)
      return () => ipcRenderer.removeListener('term:data', fn)
    },
    onExit: (cb) => {
      const fn = (_: unknown, id: string) => cb(id)
      ipcRenderer.on('term:exit', fn)
      return () => ipcRenderer.removeListener('term:exit', fn)
    },
  },
  fs: { tree: call('fs:tree'), write: call('fs:write') } as Api['fs'],
  compare: call('compare') as Api['compare'],
  gallery: {
    list: call('gallery:list'), update: call('gallery:update'), remove: call('gallery:remove'), op: call('gallery:op'),
    describe: call('gallery:describe'), enhance: call('gallery:enhance'), saveImage: call('gallery:saveImage'),
    saveAs: call('gallery:saveAs'), openWith: call('gallery:openWith'), pickImages: call('gallery:pickImages'),
    ensure: call('gallery:ensure'), saveMask: call('gallery:saveMask'),
  } as Api['gallery'],
  batch: {
    start: call('batch:start') as Api['batch']['start'],
    cancel: (id) => ipcRenderer.send('batch:cancel', id),
    onProgress: (cb) => {
      const fn = (_: unknown, st: any) => cb(st)
      ipcRenderer.on('batch:progress', fn)
      return () => ipcRenderer.removeListener('batch:progress', fn)
    },
  },
  onNav: (cb) => {
    const fn = (_: unknown, to: any) => cb(to)
    ipcRenderer.on('nav', fn)
    return () => ipcRenderer.removeListener('nav', fn)
  },
  onSettings: (cb) => {
    const fn = (_: unknown, s: any) => cb(s)
    ipcRenderer.on('settings:changed', fn)
    return () => ipcRenderer.removeListener('settings:changed', fn)
  },
  quit: () => ipcRenderer.send('app:quit'),
  shell: { open: call('shell:open'), reveal: call('shell:reveal'), external: call('shell:external') } as Api['shell'],
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    onState: (cb) => {
      const fn = (_: unknown, s: any) => cb(s)
      ipcRenderer.on('win:state', fn)
      return () => ipcRenderer.removeListener('win:state', fn)
    },
  },
  update: {
    state: call('update:state'), check: call('update:check'), download: call('update:download'), install: call('update:install'),
    onState: (cb) => {
      const fn = (_: unknown, s: any) => cb(s)
      ipcRenderer.on('update:state', fn)
      return () => ipcRenderer.removeListener('update:state', fn)
    },
  } as Api['update'],
  version: env.version,
  platform: env.platform,
  userName: env.userName,
}

contextBridge.exposeInMainWorld('api', api)
