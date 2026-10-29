import * as crypto from 'node:crypto';

/**
 * 《核心位置》：计算代码行 16 位短 SHA-256 校验和
 * 逻辑解释：
 * 1. 先进行 trim() 消除行首行尾空白字符及换行符（CRLF/LF）的差异。
 * 2. 采用 SHA-256 哈希算法计算摘要，取前 16 位小写十六进制字符串。
 * 3. 在极低碰撞率的前提下提供紧凑的内容指纹，用于判断目标代码是否产生漂移。
 * 隐患点：空字符串或全空格文本的哈希值固定为 e3b0c44298fc1c14（sha256('')前16位），属正常表现。
 */
export function computeLineHash(text: string): string {
  const normalized = (text || '').trim();
  return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

