declare module "react-syntax-highlighter" {
  import type { ComponentType, CSSProperties } from "react";
  interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, unknown>;
    customStyle?: CSSProperties;
    codeTagProps?: { className?: string };
    wrapLongLines?: boolean;
    children: string;
  }
  type RegisterableSyntaxHighlighter = ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, language: unknown) => void;
  };
  const SyntaxHighlighter: RegisterableSyntaxHighlighter;
  export { SyntaxHighlighter };
  export const Prism: RegisterableSyntaxHighlighter;
  export const PrismLight: RegisterableSyntaxHighlighter;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism" {
  export const oneLight: Record<string, unknown>;
}

declare module "react-syntax-highlighter/dist/esm/prism-light" {
  import type { ComponentType, CSSProperties } from "react";
  interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, unknown>;
    customStyle?: CSSProperties;
    codeTagProps?: { className?: string };
    wrapLongLines?: boolean;
    children: string;
  }
  type RegisterableSyntaxHighlighter = ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, language: unknown) => void;
  };
  const SyntaxHighlighter: RegisterableSyntaxHighlighter;
  export default SyntaxHighlighter;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-light" {
  const oneLight: Record<string, unknown>;
  export default oneLight;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-dark" {
  const oneDark: Record<string, unknown>;
  export default oneDark;
}

declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const language: unknown;
  export default language;
}
