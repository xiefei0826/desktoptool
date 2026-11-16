/**
 * 本地联调用的最小 SSH 服务（仅开发使用）
 *   npm run mock:ssh
 *   ssh -p 2222 admin@127.0.0.1   （密码 admin）
 *
 * 同时提供：
 *   - password 认证 + PTY + shell（验证终端字节流）
 *   - tcpip 转发（验证 -L / -D）
 *   - 127.0.0.1:9099 的假内网 HTTP 服务（转发目标）
 */
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import ssh2 from 'ssh2'

const { Server } = ssh2

const PORT = Number(process.env.MOCK_SSH_PORT ?? 2222)
const USER = process.env.MOCK_SSH_USER ?? 'admin'
const PASS = process.env.MOCK_SSH_PASSWORD ?? 'admin'
const INTERNAL_PORT = Number(process.env.MOCK_INTERNAL_PORT ?? 9099)

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})

function runCommand(command) {
  const [name, ...args] = command.split(/\s+/)
  switch (name) {
    case '':
      return ''
    case 'help':
      return '可用命令: help, echo, whoami, uname, pwd, ls, date, clear, exit'
    case 'echo':
      return args.join(' ')
    case 'whoami':
      return USER
    case 'uname':
      return `MockLinux ${process.platform} 5.15.0 mock`
    case 'pwd':
      return '/home/' + USER
    case 'ls':
      return 'README.txt  scripts  logs  backup.tar.gz'
    case 'date':
      return new Date().toString()
    case 'clear':
      return '\u001b[2J\u001b[H'
    default:
      return `bash: ${name}: command not found`
  }
}

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('mock-internal-ok')
  })
  .listen(INTERNAL_PORT, '127.0.0.1', () => {
    console.log(`[mock-ssh] internal http on 127.0.0.1:${INTERNAL_PORT}`)
  })

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) {
      ctx.accept()
      return
    }
    if (ctx.method === 'none') {
      ctx.reject(['password'])
      return
    }
    ctx.reject()
  })

  client.on('tcpip', (accept, _reject, info) => {
    const channel = accept()
    const upstream = net.connect(info.destPort, info.destIP)
    channel.pipe(upstream).pipe(channel)
    upstream.on('error', () => channel.close())
    channel.on('close', () => upstream.destroy())
  })

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()

      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('window-change', (acceptWindow) => acceptWindow?.())

      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        let buffer = ''

        stream.write(`\u001b[32mMock SSH Server\u001b[0m — ${USER}@mock\r\n`)
        stream.write('输入 help 查看可用命令\r\n$ ')

        stream.on('data', (data) => {
          const text = data.toString()
          buffer += text

          if (text.includes('\u0003')) {
            buffer = ''
            stream.write('^C\r\n$ ')
            return
          }

          if (!buffer.includes('\r')) return

          const command = buffer.replace(/[\r\n]+$/, '').trim()
          buffer = ''

          if (command === 'exit') {
            stream.write('logout\r\n')
            stream.end()
            return
          }

          stream.write(`${runCommand(command)}\r\n$ `)
        })
      })
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ssh] listening on ssh://${USER}@127.0.0.1:${PORT}  password=${PASS}`)
})
