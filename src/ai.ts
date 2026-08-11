import * as vscode from 'vscode';
import { parseUtilityModelSetting } from './ai-model';
import { PluginConfiguration } from './types';

const AI_REQUEST_TIMEOUT_MS = 60_000;

/** 模型经常无视提示词，把 JSON 包在 Markdown 代码块里，解析前先剥掉围栏。 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

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

  public async resolveConfigurationConflict(local: PluginConfiguration, cloud: PluginConfiguration): Promise<string> {
    const prompt = [
      '请合并两份插件同步设置，保留双方合理设置。只输出完整 JSON，不要 Markdown 或解释。',
      'repositoryUrl 和 branch 必须作为一组，完整选用本机版本或云端版本，不能交叉组合。',
      '不得在仓库地址中加入用户名、密码、令牌或其他凭据。',
      `本机设置：\n${JSON.stringify(local, null, 2)}`,
      `云端设置：\n${JSON.stringify(cloud, null, 2)}`,
    ].join('\n\n');
    return stripJsonFence(await this.complete(prompt));
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
