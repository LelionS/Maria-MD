// plugins.js — updated for @whiskeysockets/baileys v6+ (CommonJS style)
// NOTE: this file is a drop-in replacement for your old plugins.js adapted to the v6 API.
// It implements a small in-memory store compatible with your existing usage (loadMessage, contacts).
// Save this over your existing plugins.js and run with the v6 Baileys package.

require('./Config')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const PhoneNumber = require('awesome-phonenumber')
const NodeCache = require('node-cache')
const Pino = require('pino')
const readline = require('readline')
const { parsePhoneNumber } = require('libphonenumber-js')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./Gallery/lib/exif')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, sleep, reSize } = require('./Gallery/lib/myfunc')

// Baileys v6+ imports (CommonJS interop)
const Baileys = require('@whiskeysockets/baileys')
const makeWASocket = Baileys.default
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  generateMessageID,
  downloadContentFromMessage,
  jidDecode,
  jidNormalizedUser,
  proto,
  Browsers
} = Baileys

// Simple in-memory store implementation (provides loadMessage, contacts, bind(ev))
function createInMemoryStore () {
  const msgs = new Map() // Map<jid, Map<id, messageObj>>
  const contacts = {}
  const self = {
    contacts,
    messages: msgs,
    bind (ev) {
      // store incoming messages for loadMessage compatibility
      ev.on('messages.upsert', (m) => {
        try {
          if (!m.messages) return
          for (const message of m.messages) {
            const remote = jidNormalizedUser(message.key.remoteJid || message.key.participant || '0@s.whatsapp.net')
            if (!msgs.has(remote)) msgs.set(remote, new Map())
            // store the message keyed by id
            if (message.key && message.key.id) msgs.get(remote).set(message.key.id, message)
          }
        } catch (e) {
          // non-fatal
          // console.error('store bind messages.upsert error', e)
        }
      })

      // keep contacts updated when Baileys emits contacts.update
      ev.on('contacts.update', updates => {
        try {
          for (const c of updates) {
            const id = (c.id && typeof c.id === 'string') ? c.id : undefined
            if (!id) continue
            const normalized = jidNormalizedUser(id)
            contacts[normalized] = {
              id: normalized,
              name: c.notify || (c.name || '') // best effort
            }
          }
        } catch (e) {}
      })
    },
    loadMessage: async (jid, id) => {
      try {
        const normalized = jidNormalizedUser(jid)
        const bucket = msgs.get(normalized)
        if (!bucket) return null
        return bucket.get(id) || null
      } catch (e) {
        return null
      }
    }
  }
  return self
}

const store = createInMemoryStore()

// small helper for CLI input
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

// main start
async function startMaria () {
  try {
    // get latest baileys version (optional but good)
    const { version, isLatest } = await fetchLatestBaileysVersion()
    // auth state (multi-file)
    const { state, saveCreds } = await useMultiFileAuthState('./session')

    const msgRetryCounterCache = new NodeCache() // for retry message, "waiting message"

    const Maria = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: Browsers.appropriate('Chrome'),
      auth: {
        creds: state.creds,
        // wrap keys with a cacheable store (Baileys helper)
        keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'fatal' }).child({ level: 'fatal' }))
      },
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        // key: { remoteJid, id, ... }
        try {
          const jid = jidNormalizedUser(key.remoteJid || key.participant || '0@s.whatsapp.net')
          const msg = await store.loadMessage(jid, key.id)
          return (msg && msg.message) ? msg.message : undefined
        } catch (e) {
          return undefined
        }
      },
      msgRetryCounterCache,
      defaultQueryTimeoutMs: undefined
    })

    // bind our simple store to socket events so it populates
    store.bind(Maria.ev)

    // persist creds when updated
    Maria.ev.on('creds.update', saveCreds)

    // connection update
    Maria.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update
      if (connection === 'open') {
        console.log(chalk.green('🟨Welcome to Maria-md (Baileys v6 compatible)'))
        console.log(chalk.gray('\n\n🚀Initializing...'))
        console.log(chalk.cyan('\n\n🧩Connected'))
        console.log(chalk.cyan('\n\n⏳️waiting for messages'))
      }
      if (connection === 'close') {
        const shouldReconnect = !!(lastDisconnect && lastDisconnect.error && (lastDisconnect.error.output?.statusCode !== 401))
        if (shouldReconnect) {
          // try reconnect
          console.log(chalk.yellow('Connection closed, trying to restart...'))
          startMaria().catch(console.error)
        } else {
          // credentials invalid or logged out
          console.log(chalk.red('Connection closed. Might be logged out.'))
        }
      }
    })

    // messages.upsert handler (primary message processing)
    Maria.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        // keep existing behavior: grab first message
        const mek = chatUpdate.messages && chatUpdate.messages[0]
        if (!mek) return
        if (!mek.message) return
        // handle ephemeral wrapper
        const messageContent = (Object.keys(mek.message)[0] === 'ephemeralMessage')
          ? mek.message.ephemeralMessage.message
          : mek.message
        mek.message = messageContent

        // ignore status broadcast
        if (mek.key && mek.key.remoteJid === 'status@broadcast') {
          // optional autoread_status — keep original variable if defined in Config or elsewhere
          if (typeof autoread_status !== 'undefined' && autoread_status) {
            await Maria.readMessages([mek.key]).catch(() => {})
          }
          return
        }

        // ignore non-public messages when Maria.public false
        if (!Maria.public && !mek.key.fromMe && chatUpdate.type === 'notify') return

        // ignore some system ids
        if (mek.key.id && mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return

        // pass through your helper that normalizes the message object
        const m = smsg(Maria, mek, store)
        // call Heart handler (your existing plugin)
        require('./Heart')(Maria, m, chatUpdate, store)
      } catch (err) {
        console.error('messages.upsert handler error:', err)
      }
    })

    // update contacts in store when Baileys updates them
    Maria.ev.on('contacts.update', updates => {
      for (const contact of updates) {
        try {
          const id = Maria.decodeJid ? Maria.decodeJid(contact.id) : (contact.id || '')
          const normalized = jidNormalizedUser(id || contact.id)
          if (store && store.contacts) store.contacts[normalized] = {
            id: normalized,
            name: contact.notify || contact.name || ''
          }
        } catch (e) {}
      }
    })

    // helper decodeJid (keeps your original behavior)
    Maria.decodeJid = (jid) => {
      if (!jid) return jid
      if (/:\d+@/gi.test(jid)) {
        let decoded = jidDecode(jid) || {}
        return decoded.user && decoded.server && decoded.user + '@' + decoded.server || jid
      } else return jid
    }

    // helper getName similar to original
    Maria.getName = (jid, withoutContact = false) => {
      const id = Maria.decodeJid(jid)
      withoutContact = Maria.withoutContact || withoutContact
      let v
      if (id.endsWith('@g.us')) {
        return new Promise(async (resolve) => {
          v = store.contacts[id] || {}
          if (!(v.name || v.subject)) v = (await Maria.groupMetadata ? await Maria.groupMetadata(id) : {}) || {}
          resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
      } else {
        v = id === '0@s.whatsapp.net'
          ? { id, name: 'WhatsApp' }
          : id === Maria.decodeJid(Maria.user?.id)
            ? Maria.user
            : (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
      }
    }

    // public flag
    Maria.public = true

    // serializer to be used by other modules (Heart, plugins)
    Maria.serializeM = (m) => smsg(Maria, m, store)

    // convenience send wrappers (unchanged functionality)
    Maria.sendText = (jid, text, quoted = '', options) => Maria.sendMessage(jid, { text, ...options }, { quoted, ...options })

    Maria.sendTextWithMentions = async (jid, text, quoted, options = {}) => Maria.sendMessage(
      jid,
      {
        text,
        mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'),
        ...options
      },
      { quoted }
    )

    Maria.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
      let buff = Buffer.isBuffer(path)
        ? path
        : /^data:.*?\/.*?;base64,/i.test(path)
          ? Buffer.from(path.split`,`[1], 'base64')
          : /^https?:\/\//.test(path)
            ? await getBuffer(path)
            : fs.existsSync(path)
              ? fs.readFileSync(path)
              : Buffer.alloc(0)

      let buffer
      if (options && (options.packname || options.author)) buffer = await writeExifImg(buff, options)
      else buffer = await imageToWebp(buff)

      await Maria.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted })
      return buffer
    }

    Maria.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
      let buff = Buffer.isBuffer(path)
        ? path
        : /^data:.*?\/.*?;base64,/i.test(path)
          ? Buffer.from(path.split`,`[1], 'base64')
          : /^https?:\/\//.test(path)
            ? await getBuffer(path)
            : fs.existsSync(path)
              ? fs.readFileSync(path)
              : Buffer.alloc(0)

      let buffer
      if (options && (options.packname || options.author)) buffer = await writeExifVid(buff, options)
      else buffer = await videoToWebp(buff)

      await Maria.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted })
      return buffer
    }

    Maria.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
      const quoted = message.msg ? message.msg : message
      const mime = (message.msg || message).mimetype || ''
      const messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
      const stream = await downloadContentFromMessage(quoted, messageType)
      let buffer = Buffer.from([])
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])
      const type = await FileType.fromBuffer(buffer)
      const trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
      await fs.writeFileSync(trueFileName, buffer)
      return trueFileName
    }

    Maria.downloadMediaMessage = async (message) => {
      const mime = (message.msg || message).mimetype || ''
      const messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
      const stream = await downloadContentFromMessage(message, messageType)
      let buffer = Buffer.from([])
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])
      return buffer
    }

    return Maria
  } catch (err) {
    console.error('startMaria error:', err)
    throw err
  }
}

// start the client
startMaria().catch(err => console.error('Failed to start Maria:', err))

// hot-reload watcher (keeps your original behavior)
let file = require.resolve(__filename)
fs.watchFile(file, () => {
  fs.unwatchFile(file)
  console.log(chalk.redBright(`Update ${__filename}`))
  delete require.cache[file]
  require(file)
})

// global uncaught exception handling (keeps your original filters)
process.on('uncaughtException', function (err) {
  let e = String(err)
  if (e.includes('Socket connection timeout')) return
  if (e.includes('item-not-found')) return
  if (e.includes('rate-overlimit')) return
  if (e.includes('Connection Closed')) return
  if (e.includes('Timed Out')) return
  if (e.includes('Value not found')) return
  console.log('Caught exception: ', err)
})
