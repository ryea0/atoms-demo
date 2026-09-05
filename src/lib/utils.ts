// 合并 Tailwind 类名（clsx 组合 + tailwind-merge 去重），见 .claude/rules/04-tailwind.md
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
