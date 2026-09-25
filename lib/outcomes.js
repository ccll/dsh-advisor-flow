/**
 * 意见采纳回写存储（Outcome Store，R-01-008；pi outcomes.ts 形态移植）。
 *
 * 逐条移植 pi 0.8.2（outcomes.ts）：HMAC-SHA256 截断 16 hex 承载意见原文
 * （不存明文）、盐 32 字节经临时文件 + link() 原子发布（20 次竞争重试）、
 * wx 独占锁 200 次×5ms 重试 + 30 秒陈旧锁回收、1MB 轮转（溢出即重写单行）、
 * 文件 0o600/目录 0o700。
 *
 * @module dsh-advisor-flow/outcomes
 */

import { createHmac, randomBytes } from 'node:crypto';
import { appendFile, chmod, link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_LOG_BYTES = 1024 * 1024;

const isErrnoException = (error) => error instanceof Error && 'code' in error;

/**
 * 采纳/验证枚举（pi ADOPTIONS/VALIDATIONS 逐字）。
 */
export const ADOPTIONS = ['followed', 'not-followed', 'unknown'];
export const VALIDATIONS = ['passed', 'failed', 'not-run', 'unknown'];

/**
 * 盐：32 字节经临时文件（0o600）+ link() 原子发布到目标路径；竞争者按序
 * 重试直至一个盐被原子发布（pi salt() 语义，R-01-008/AC-06 密钥独立生成保管）。
 */
const salt = async (path, dir) => {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const existing = await readFile(path);
            if (existing.length === 32) {
                return existing;
            }
            // 回收被更早中断的写者遗留的不完整盐文件。
            await unlink(path);
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'ENOENT') {
                throw error;
            }
        }
        const value = randomBytes(32);
        const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.${attempt}`;
        await writeFile(temporary, value, { mode: 0o600 });
        try {
            await link(temporary, path);
            return value;
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'EEXIST') {
                throw error;
            }
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
    throw new Error('Advisor outcome salt initialization did not complete.');
};

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

/** wx 独占锁：200 次×5ms 重试 + 30 秒陈旧锁按身份回收（pi withOutcomeLock）。 */
async function withOutcomeLock(run, outcomeLogPath) {
    const lockPath = `${outcomeLogPath()}.lock`;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
            const lock = await open(lockPath, 'wx', 0o600);
            const identity = await lock.stat();
            try {
                return await run();
            } finally {
                await lock.close();
                const current = await stat(lockPath).catch(() => undefined);
                if (current && sameFile(identity, current)) {
                    await unlink(lockPath).catch(() => undefined);
                }
            }
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'EEXIST') {
                throw error;
            }
            const observed = await stat(lockPath).catch(() => undefined);
            if (observed && Date.now() - observed.mtimeMs > 30_000) {
                const current = await stat(lockPath).catch(() => undefined);
                if (current && sameFile(observed, current)) {
                    await unlink(lockPath).catch(() => undefined);
                }
                continue;
            }
            await sleep(5);
        }
    }
    throw new Error('Timed out waiting to append an Advisor outcome.');
}

const adviceDigest = (advice, key) =>
    createHmac('sha256', key).update(advice).digest('hex').slice(0, 16);

/**
 * 创建回写存储（pi appendOutcome 语义移植）：
 * 意见原文以 HMAC-SHA256 截断 16 hex 落盘（不存明文）；单行 JSONL；1MB 轮转；
 * saltFile 与台账同置（哈希为防篡改证据而非保密手段，AC-06）。
 * @param {object} options
 * @param {string} options.file 台账 JSONL 路径（目录即数据目录）
 * @param {Buffer|string} [options.hmacKey] 显式密钥（测试注入）；缺省时由
 *   `${file}.salt` 独立生成与保管
 */
export function createOutcomeStore({ file, hmacKey }) {
    const logPath = typeof file === 'string' ? file : '';
    const dir = dirname(logPath);
    const saltPath = `${logPath}.salt`;
    const getSalt = async () => {
        await mkdir(dir, { mode: 0o700, recursive: true });
        if (hmacKey !== undefined) {
            return Buffer.isBuffer(hmacKey) ? hmacKey : Buffer.from(String(hmacKey), 'utf8');
        }
        return salt(saltPath, dir);
    };
    return {
        /** 追加一条回写记录（失败即抛——调用方显性化，AC-06 fail-closed）。 */
        append: async (record) =>
            withOutcomeLock(async () => {
                const next = {
                    adoption: record.adoption,
                    adviceHash: adviceDigest(record.advice, await getSalt()),
                    timestamp: new Date().toISOString(),
                    trigger: record.trigger,
                    v: 1,
                    validationStatus: record.validationStatus,
                };
                const line = `${JSON.stringify(next)}\n`;
                const currentBytes = await stat(logPath)
                    .then((value) => value.size)
                    .catch((error) => {
                        if (isErrnoException(error) && error.code === 'ENOENT') {
                            return 0;
                        }
                        throw error;
                    });
                const overflow = currentBytes + Buffer.byteLength(line) > MAX_LOG_BYTES;
                await (overflow
                    ? writeFile(logPath, line, { encoding: 'utf-8', mode: 0o600 })
                    : appendFile(logPath, line, { encoding: 'utf-8', mode: 0o600 }));
                await chmod(logPath, 0o600); // pi 无吞错：权限未达显性化
                return next;
            }, () => logPath),
    };
}
