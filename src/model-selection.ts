/**
 * 用户勾了哪些模型（按上游分开放）。
 *
 * 勾选结果存在本机：`~/.dsh/<范围>/selection.json`。读写逻辑已迁到
 * @goodjin2/dsh-model-kit；这里从公共件再导出，保持本仓既有引用路径不变。
 */

export { selectionFilePath, readSelection, writeSelection, clearSelection } from '@goodjin2/dsh-model-kit'
