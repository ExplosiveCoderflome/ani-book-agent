import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  ListsToggle,
  MDXEditor,
  UndoRedo,
  diffSourcePlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type Translation,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

const plugins = [
  headingsPlugin(),
  listsPlugin(),
  quotePlugin(),
  thematicBreakPlugin(),
  tablePlugin(),
  linkPlugin(),
  linkDialogPlugin(),
  markdownShortcutPlugin(),
  diffSourcePlugin({ viewMode: "rich-text" }),
  toolbarPlugin({
    toolbarContents: () => (
      <DiffSourceToggleWrapper options={["rich-text", "source"]}>
        <UndoRedo />
        <BlockTypeSelect />
        <BoldItalicUnderlineToggles />
        <ListsToggle />
        <CreateLink />
      </DiffSourceToggleWrapper>
    ),
  }),
];

const labels: Record<string, string> = {
  "Undo": "撤销",
  "Redo": "重做",
  "Block type": "段落样式",
  "Select block type": "选择段落样式",
  "Paragraph": "段落",
  "Quote": "引用",
  "Heading {{level}}": "标题 {{level}}",
  "Bold": "粗体",
  "Italic": "斜体",
  "Underline": "下划线",
  "Bulleted list": "项目列表",
  "Numbered list": "编号列表",
  "Check list": "任务列表",
  "Create link": "插入链接",
  "Rich text": "可视化编辑",
  "Source mode": "源码",
  "editable markdown": "Markdown 文档编辑器",
};
const translate: Translation = (_key, fallback, interpolations) => Object.entries(interpolations ?? {}).reduce((value, [key, replacement]) => value.replaceAll(`{{${key}}}`, String(replacement)), labels[fallback] ?? fallback);

export function MarkdownEditor({ markdown, fileKey, onChange }: { markdown: string; fileKey: string; onChange: (markdown: string, initialMarkdownNormalize: boolean) => void }) {
  return <MDXEditor key={fileKey} className="novel-markdown-editor mdxeditor-full-height" contentEditableClassName="novel-markdown-content" markdown={markdown} onChange={onChange} plugins={plugins} translation={translate} />;
}
