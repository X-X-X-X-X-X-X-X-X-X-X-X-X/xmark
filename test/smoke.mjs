import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StandaloneBookmarkManager } from '../src/core/bookmarkCore.js';

async function runSmokeTest() {
  const testDir = path.resolve(process.cwd(), 'temp_test_workspace');
  await fs.mkdir(testDir, { recursive: true });

  const dummyFilePath = path.join(testDir, 'test_file.ts');
  await fs.writeFile(
    dummyFilePath,
    '// line 1\nexport function calculateSum(a: number, b: number) {\n  return a + b;\n}\n',
    'utf-8'
  );

  const manager = new StandaloneBookmarkManager(testDir);

  // 1. 测试读取初始状态
  const initialSchema = await manager.load();
  assert.strictEqual(initialSchema.version, 1);
  assert.strictEqual(initialSchema.groups[0].id, 'default');

  // 2. 测试行 Hash 计算与提取
  const { content, hash } = await manager.getLineContentAndHash('test_file.ts', 2);
  assert.strictEqual(content, 'export function calculateSum(a: number, b: number) {');
  assert.strictEqual(hash.length, 16);

  // 3. 测试书签添加与落盘
  initialSchema.bookmarks.push({
    id: 'test_bm_1',
    groupId: 'default',
    name: '求和函数核心入口',
    filePath: 'test_file.ts',
    line: 2,
    commit: 'dummy_commit_hash',
    lineHash: hash,
    order: 0,
    createdAt: Date.now()
  });
  await manager.save(initialSchema);

  // 4. 测试再次读取
  const reloaded = await manager.load();
  assert.strictEqual(reloaded.bookmarks.length, 1);
  assert.strictEqual(reloaded.bookmarks[0].name, '求和函数核心入口');
  assert.strictEqual(reloaded.bookmarks[0].lineHash, hash);

  // 清理测试临时文件
  await fs.rm(testDir, { recursive: true, force: true });
  console.log('✅ 所有冒烟测试用例全部通过！');
}

runSmokeTest().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});

