import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BookmarkCore } from '../src/core/bookmarkCore.ts';
import { computeLineHash } from '../src/core/hashUtil.ts';

async function runMcpCoreTest() {
  const tempDir = path.resolve(process.cwd(), 'temp_test_mcp_workspace');
  await fs.mkdir(tempDir, { recursive: true });

  const dummyFilePath = path.join(tempDir, 'demo.ts');
  const fileLines = [
    '// Demo file for MCP test',
    'export function authenticateUser(token: string): boolean {',
    '  if (!token) return false;',
    '  return token.startsWith("Bearer ");',
    '}'
  ];
  await fs.writeFile(dummyFilePath, fileLines.join('\n'), 'utf-8');

  console.log('1. 初始化 BookmarkCore...');
  const core = new BookmarkCore(tempDir, 'vscode');
  const initialSchema = await core.load();
  assert.strictEqual(initialSchema.version, 1);
  assert.strictEqual(initialSchema.groups[0].id, 'default');

  console.log('2. 测试自动计算短哈希与添加书签...');
  const bm1 = await core.addBookmark({
    filePath: 'demo.ts',
    line: 2,
    name: '鉴权核心入口',
    groupName: '安全认证',
    autoCompute: true
  });
  assert.strictEqual(bm1.line, 2);
  assert.strictEqual(bm1.filePath, 'demo.ts');
  const expectedHash = computeLineHash(fileLines[1]);
  assert.strictEqual(bm1.lineHash, expectedHash);
  assert.strictEqual(bm1.lineHash.length, 16);

  console.log('3. 测试分组创建与查询...');
  const groups = core.listGroups();
  assert.strictEqual(groups.length, 2);
  const authGroup = groups.find((g) => g.name === '安全认证');
  assert.ok(authGroup);
  assert.strictEqual(bm1.groupId, authGroup.id);

  console.log('4. 测试漂移检测 (无变动状态)...');
  const driftStatusNoChange = await core.checkDrift(bm1.id);
  assert.ok(driftStatusNoChange);
  assert.strictEqual(driftStatusNoChange.hasChanged, false);

  console.log('5. 测试漂移检测 (修改代码后的变动状态)...');
  // 修改第二行代码
  fileLines[1] = 'export function authenticateUser(jwtToken: string): boolean {';
  await fs.writeFile(dummyFilePath, fileLines.join('\n'), 'utf-8');

  const driftStatusChanged = await core.checkDrift(bm1.id);
  assert.ok(driftStatusChanged);
  assert.strictEqual(driftStatusChanged.hasChanged, true);

  console.log('6. 测试重构后更新行号与自动刷新哈希 (refreshHash)...');
  const updatedBm = await core.updateBookmark(bm1.id, {
    line: 2,
    refreshHash: true
  });
  assert.ok(updatedBm);
  const newExpectedHash = computeLineHash(fileLines[1]);
  assert.strictEqual(updatedBm.lineHash, newExpectedHash);

  const driftStatusAfterRefresh = await core.checkDrift(bm1.id);
  assert.ok(driftStatusAfterRefresh);
  assert.strictEqual(driftStatusAfterRefresh.hasChanged, false);

  console.log('7. 测试删除分组 (组内书签归入 default)...');
  const deleteGroupOk = await core.deleteGroup(authGroup.id);
  assert.strictEqual(deleteGroupOk, true);
  const bmAfterGroupDeleted = core.getBookmark(bm1.id);
  assert.strictEqual(bmAfterGroupDeleted?.groupId, 'default');

  console.log('8. 测试删除书签与清理落盘...');
  const deleteBmOk = await core.deleteBookmark(bm1.id);
  assert.strictEqual(deleteBmOk, true);
  assert.strictEqual(core.getBookmarks().length, 0);

  // 清理测试临时目录
  await fs.rm(tempDir, { recursive: true, force: true });
  console.log('🎉 [XMark MCP Core] 8 项完整功能测试全部通过！');
}

runMcpCoreTest().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
