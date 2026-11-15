import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const LARK_TIMEOUT_MS = 20000;

function larkArgs(config, args) {
  return [...args, '--as', 'bot'];
}

async function runLark(config, args) {
  const { stdout } = await exec(config.feishu.larkCli, larkArgs(config, args), {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function replyMessage(config, messageId, markdown) {
  const args = ['im', '+messages-reply', '--message-id', messageId, '--markdown', markdown];
  if (config.feishu.replyToThread) args.push('--reply-in-thread');
  await runLark(config, args);
}

export async function sendMessage(config, markdown) {
  await runLark(config, ['im', '+messages-send', '--chat-id', config.feishu.chatId, '--markdown', markdown]);
}

/**
 * Stream `im.message.receive_v1` events. The event bus is shared by every
 * lark-cli consumer, so this never steals events from other local tools.
 */
export function consumeMessages(config, onEvent, log = () => {}) {
  let child = null;
  let stopped = false;
  let backoff = 2000;

  const start = () => {
    if (stopped) return;
    child = spawn(config.feishu.larkCli, larkArgs(config, ['event', 'consume', 'im.message.receive_v1']), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        log(`无法解析事件：${trimmed.slice(0, 120)}`);
        return;
      }
      backoff = 2000;
      Promise.resolve(onEvent(event)).catch((error) => log(`处理事件失败：${error.message}`));
    });
    const errors = createInterface({ input: child.stderr });
    errors.on('line', (line) => {
      if (line.includes('[event] ready')) {
        log('飞书事件通道已就绪');
        backoff = 2000;
      } else if (line.includes('[event] exited')) {
        log(line.trim());
      }
    });
    child.on('exit', (code, signal) => {
      if (stopped) return;
      log(`飞书事件通道退出（code=${code} signal=${signal}），${Math.round(backoff / 1000)}s 后重连`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
  };

  start();

  return () => {
    stopped = true;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
}
