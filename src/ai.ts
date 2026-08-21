import * as vscode from 'vscode';
import { parseUtilityModelSetting } from './ai-model';

const AI_REQUEST_TIMEOUT_MS = 60_000;

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

  private async complete(prompt: string): Promise<string> {
    const utilitySetting = vscode.workspace.getConfiguration('chat').get<string>('utilitySmallModel', '').trim();
    const utilitySelector = parseUtilityModelSetting(utilitySetting);
    let models = utilitySelector ? await vscode.lm.selectChatModels(utilitySelector) : [];
    if (!models.length) models = await vscode.lm.selectChatModels({});
    const model = models[0];
    if (!model) throw new Error('当前 IDE 没有向扩展开放默认 AI 模型，提交已暂停。');
    const cancellation = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cancellation.cancel(), AI_REQUEST_TIMEOUT_MS);
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cancellation.token
      );
      let text = '';
      for await (const fragment of response.text) {
        if (cancellation.token.isCancellationRequested) {
          throw new Error('AI 请求超时。');
        }
        text += fragment;
      }
      return text.trim();
    } catch (error) {
      if (cancellation.token.isCancellationRequested) {
        throw new Error('AI 请求超时。');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
    }
  }
}
