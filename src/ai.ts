import * as vscode from 'vscode';
import { parseUtilityModelSetting } from './ai-model';

export class AiService {
  public async createCommitMessage(summary: string): Promise<string> {
    const prompt = [
      '你是 Git 提交信息生成器。根据下面的配置文件变化生成一行简洁的中文 Conventional Commit。',
      '只输出提交信息，不要 Markdown，不超过 72 个字符，不得包含换行。',
      summary
    ].join('\n\n');
    const response = await this.complete(prompt);
    const message = response.replace(/[\r\n]+/g, ' ').trim().slice(0, 72);
    if (!message) throw new Error('AI 未返回有效的提交信息。');
    return message;
  }

  public async resolveConflict(path: string, base: string, ours: string, theirs: string): Promise<string> {
    const prompt = [
      '请合并同一个 VS Code 配置文件的三个版本。保留双方不冲突的修改；冲突时选择语义更完整且不泄露凭据的结果。',
      '只输出合并后的文件原文，不要 Markdown 代码块或解释。',
      `文件：${path}`,
      `共同基础：\n${base}`,
      `本机版本：\n${ours}`,
      `远程版本：\n${theirs}`
    ].join('\n\n');
    return this.complete(prompt);
  }

  private async complete(prompt: string): Promise<string> {
    const utilitySetting = vscode.workspace.getConfiguration('chat').get<string>('utilitySmallModel', '').trim();
    const utilitySelector = parseUtilityModelSetting(utilitySetting);
    let models = utilitySelector ? await vscode.lm.selectChatModels(utilitySelector) : [];
    if (!models.length) models = await vscode.lm.selectChatModels({});
    const model = models[0];
    if (!model) throw new Error('当前 IDE 没有向扩展开放默认 AI 模型，提交已暂停。');
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cancellation.token
      );
      let text = '';
      for await (const fragment of response.text) text += fragment;
      return text.trim();
    } finally {
      cancellation.dispose();
    }
  }
}
