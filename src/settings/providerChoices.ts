import { t, type UiLocale } from "../i18n/strings";

/** 无供应商时 QuickPick 推荐动作。 */
export type NoProviderAction = "template" | "ccswitch" | "manual";

export interface NoProviderChoice {
  label: string;
  detail: string;
  action: NoProviderAction;
}

/** 默认兼容端点内置模板一键创建的 baseUrl。 */
export const DEFAULT_COMPAT_BASE_URL = "https://api.deepseek.com/anthropic";

/**
 * 无供应商时的推荐式引导项(管理供应商命令/首次引导共用):
 * 1. 默认兼容端点(内置模板)一键创建;
 * 2. 从 cc-switch 导入;
 * 3. 手动创建(名称 + Base URL + API Key)。
 */
export function noProviderChoices(locale: UiLocale): NoProviderChoice[] {
  return [
    {
      label: t("默认兼容端点(内置模板)", locale),
      detail: DEFAULT_COMPAT_BASE_URL,
      action: "template",
    },
    {
      label: t("从 cc-switch 导入", locale),
      detail: t("读取 ~/.cc-switch 中已配置的兼容供应商", locale),
      action: "ccswitch",
    },
    {
      label: t("手动创建", locale),
      detail: t("名称 + Base URL + API Key", locale),
      action: "manual",
    },
  ];
}
