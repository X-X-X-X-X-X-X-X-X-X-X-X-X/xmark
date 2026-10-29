/**
 * XMark 书签核心类型定义
 */

export interface IBookmark {
  /** 唯一标识符 (例如 bm_1719000000000_abcd) */
  id: string;
  /** 所属分组 ID (未分配则默认为 DEFAULT_GROUP_ID) */
  groupId: string;
  /** 书签名 (简短标题) */
  name: string;
  /** 相对工作区根目录的路径 (统一使用 POSIX 正斜杠 '/') */
  filePath: string;
  /** 行号 (1-based) */
  line: number;
  /** 记录时的 Git Commit Hash (无 git 仓库时为空字符串) */
  commit: string;
  /** 记录时目标行 trim 后的 16 位 SHA-256 Hash 值 */
  lineHash: string;
  /** 组内排序权重 (升序排列) */
  order: number;
  /** 创建时间戳 (ms) */
  createdAt: number;
}

export interface IBookmarkGroup {
  /** 分组唯一 ID (默认组固定为 'default') */
  id: string;
  /** 分组显示名称 */
  name: string;
  /** 分组在侧边栏的排序权重 (升序排列) */
  order: number;
}

export interface IBookmarkStorageSchema {
  /** 数据结构契约版本号 */
  version: 1;
  /** 默认分组 ID */
  defaultGroupId: string;
  /** 分组列表 */
  groups: IBookmarkGroup[];
  /** 书签列表 */
  bookmarks: IBookmark[];
}

export interface IDriftStatus {
  /** 是否存在代码内容变动 */
  hasChanged: boolean;
  /** 该行内容的 Hash 是否不匹配 */
  contentChanged: boolean;
}

export const DEFAULT_GROUP_ID = 'default';
export const DEFAULT_GROUP_NAME = '默认分组';
