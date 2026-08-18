import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, FileCode, FilePlus, FolderInput, LoaderCircle, PackageOpen, Play, RefreshCw, RotateCcw, Save, ShieldAlert, Sparkles, Upload } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SkillBindingsView, SkillDraftView, SkillFileView, SkillRecordView } from "../shared/contracts";
import { api } from "./api";

async function digest(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
function binaryString(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(value);
}
function textFile(path: string, content: string, mimeType = "text/markdown"): Promise<SkillFileView> {
  return digest(content).then((sha256) => ({ path, kind: "text", content, size: new TextEncoder().encode(content).byteLength, sha256, mimeType }));
}
function isTextFile(file: File) { return file.type.startsWith("text/") || /\.(?:md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|py|sh|ps1|css|html)$/i.test(file.name); }
async function browserFile(file: File, path: string): Promise<SkillFileView> {
  if (isTextFile(file)) return textFile(path, await file.text(), file.type || undefined);
  const buffer = await file.arrayBuffer();
  return { path, kind: "binary", base64: binaryString(buffer), size: buffer.byteLength, sha256: await digest(buffer), mimeType: file.type || undefined };
}
async function currentFiles(files: SkillFileView[]) {
  return Promise.all(files.map((file) => file.kind === "text" ? textFile(file.path, file.content ?? "", file.mimeType) : Promise.resolve(file)));
}
function template(name: string, description: string) {
  return ["---", "name: " + name, "description: " + JSON.stringify(description), "---", "", "# " + name, "", "写明 Agent 应遵循的创作方法、使用步骤和质量标准。", ""].join("\n");
}
function sourceLabel(skill: SkillRecordView) { return skill.official ? "官方" : skill.source === "derived" ? "派生" : skill.source === "imported" ? "导入" : "自定义"; }

const skillPresentation: Record<string, { label: string; description: string }> = {
  discovery: { label: "开书探索", description: "把模糊念头整理成题材、冲突和故事方向" },
  blueprint: { label: "故事蓝图", description: "确定主角、核心矛盾、主线和结局走向" },
  "character-planning": { label: "角色规划", description: "规划角色动力、关系张力、人物弧并同步当前事实" },
  "volume-planning": { label: "卷与节奏规划", description: "拆分卷目标、关键转折和章节推进节奏" },
  "chapter-writing": { label: "章节写作", description: "根据章节计划生成连贯的正文内容" },
  critique: { label: "章节质量审阅", description: "检查人物、情节、节奏和表达问题" },
  "project-review": { label: "全书项目审查", description: "从全局检查设定一致性、伏笔和长线质量" },
};
const skillOrder = ["discovery", "blueprint", "character-planning", "volume-planning", "chapter-writing", "critique", "project-review"];
function skillInfo(skill: SkillRecordView) { return skillPresentation[skill.id] ?? { label: skill.name, description: skill.description }; }

export function SkillLibrary() {
  const navigate = useNavigate(); const client = useQueryClient();
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const sandbox = useQuery({ queryKey: ["skill-sandbox"], queryFn: api.sandboxCapabilities });
  const [creating, setCreating] = useState(false); const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const content = template(name.trim(), description.trim());
      return api.createSkill({ name: name.trim(), description: description.trim(), files: [await textFile("SKILL.md", content)], compatibleAgents: ["novel-agent"], taskTypes: [], requiresSandbox: false });
    },
    onSuccess: async (result) => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills/" + result.record.id); },
  });
  const derive = useMutation({ mutationFn: api.deriveSkill, onSuccess: async (result) => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills/" + result.record.id); } });
  const reload = useMutation({ mutationFn: api.reloadBuiltinSkills, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["skills"] }); } });
  const imported = useMutation({
    mutationFn: async (list: FileList) => {
      const raw = [...list]; const prefix = raw[0]?.webkitRelativePath.split("/")[0] ?? "";
      const files = await Promise.all(raw.map((file) => browserFile(file, file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(prefix ? 1 : 0).join("/") : file.name)));
      const entry = files.find((file) => file.path === "SKILL.md" && file.kind === "text");
      if (!entry) throw new Error("所选目录根部没有 SKILL.md。");
      const frontmatter = entry.content?.match(/^---\n([\s\S]*?)\n---/i)?.[1] ?? "";
      const importedName = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? prefix;
      const importedDescription = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? "导入的创作 Skill";
      return api.importSkill({ name: importedName, description: importedDescription, files, compatibleAgents: ["novel-agent"], taskTypes: [], requiresSandbox: files.some((file) => file.path.startsWith("scripts/")) });
    },
    onSuccess: async (result) => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills/" + result.record.id); },
  });
  const gitImport = useMutation({ mutationFn: api.importGitSkill, onSuccess: async (result) => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills/" + result.record.id); } });
  const zipImport = useMutation({ mutationFn: async (file: File) => api.importZipSkill(binaryString(await file.arrayBuffer())), onSuccess: async (result) => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills/" + result.record.id); } });
  return <main className="skills-page">
    <header className="skills-topbar"><Link to="/"><ArrowLeft />作品</Link><div><small>CREATIVE METHODS</small><h1>创作 Skill</h1></div><div className="skills-top-actions"><button className="quiet-action" disabled={reload.isPending} onClick={() => reload.mutate()} title="重新读取仓库中的内置 SKILL.md"><RefreshCw className={reload.isPending ? "spin" : ""} />{reload.isPending ? "正在刷新" : "刷新内置 Skill"}</button><label className="button-like"><FolderInput />导入目录<input type="file" multiple {...({ webkitdirectory: "" } as any)} onChange={(event) => event.currentTarget.files?.length && imported.mutate(event.currentTarget.files)} /></label><label className="button-like"><PackageOpen />导入 ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => event.currentTarget.files?.[0] && zipImport.mutate(event.currentTarget.files[0])} /></label><button className="quiet-action" disabled={gitImport.isPending} onClick={() => { const url = window.prompt("输入 HTTPS Git 仓库地址"); if (!url) return; const subdir = window.prompt("Skill 子目录（仓库根目录请留空）") || undefined; gitImport.mutate({ url, subdir }); }}><PackageOpen />从 Git 导入</button><button onClick={() => setCreating(true)}><FilePlus />新建 Skill</button></div></header>
    {reload.data && <p className="skill-refresh-result">{reload.data.updated.length ? `已刷新 ${reload.data.updated.length} 个：${reload.data.updated.map((id) => skillPresentation[id]?.label ?? id).join("、")}` : `已检查 ${reload.data.checked} 个内置 Skill，没有文件变化。`}</p>}
    <section className="skills-summary"><div><strong>{skills.data?.skills.length ?? "—"}</strong><span>可用方法</span></div><div><strong>{skills.data?.skills.filter((item) => item.status === "published").length ?? "—"}</strong><span>已发布</span></div><div className={sandbox.data?.configured ? "ok" : "warning"}>{sandbox.data?.configured ? <Check /> : <ShieldAlert />}<span>{sandbox.data?.configured ? "隔离执行已配置" : "脚本执行未配置"}</span></div></section>
    {creating && <section className="skill-create-panel"><div><small>新建草稿</small><h2>先写清楚它解决什么创作问题</h2></div><label>名称<input value={name} onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="character-arc" /></label><label>使用说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用于规划人物成长弧和关键转折" /></label><div><button disabled={!name || !description || create.isPending} onClick={() => create.mutate()}>{create.isPending ? <LoaderCircle className="spin" /> : <Sparkles />}创建</button><button className="quiet-action" onClick={() => setCreating(false)}>取消</button></div>{create.error && <p className="skill-error">{create.error.message}</p>}</section>}
    {skills.isLoading ? <div className="skill-loading"><LoaderCircle className="spin" />正在读取 Skill…</div> : <section className="skill-grid">{skills.data?.skills.map((skill) => <article className="skill-card" key={skill.id}><header><span className={skill.official ? "official" : ""}>{sourceLabel(skill)}</span><small>{skill.status === "published" ? "已发布" : skill.status === "draft" ? "草稿" : "已归档"}</small></header><Link to={"/skills/" + skill.id}><h2>{skill.name}</h2><p>{skill.description}</p></Link><footer><div>{skill.taskTypes.slice(0, 3).map((task) => <span key={task}>{task}</span>)}</div>{skill.official ? <button disabled={derive.isPending} onClick={() => derive.mutate(skill.id)}><Copy />派生编辑</button> : <Link to={"/skills/" + skill.id}>打开</Link>}</footer></article>)}</section>}
    {(skills.error || reload.error || imported.error || zipImport.error || gitImport.error || derive.error) && <p className="skill-error">{(skills.error ?? reload.error ?? imported.error ?? zipImport.error ?? gitImport.error ?? derive.error)?.message}</p>}
  </main>;
}

export function SkillEditor() {
  const { skillId = "" } = useParams(); const client = useQueryClient(); const navigate = useNavigate();
  const detail = useQuery({ queryKey: ["skill", skillId], queryFn: () => api.skill(skillId), enabled: Boolean(skillId) });
  const versions = useQuery({ queryKey: ["skill-versions", skillId], queryFn: () => api.skillVersions(skillId), enabled: Boolean(skillId) });
  const sandbox = useQuery({ queryKey: ["skill-sandbox"], queryFn: api.sandboxCapabilities });
  const [files, setFiles] = useState<SkillFileView[]>([]); const [selected, setSelected] = useState("SKILL.md"); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!detail.data || dirty) return; setFiles(detail.data.version.files); setName(detail.data.record.name); setDescription(detail.data.record.description); }, [detail.data, dirty]);
  const selectedFile = files.find((file) => file.path === selected);
  const draft = async (): Promise<SkillDraftView> => ({ expectedVersionId: detail.data?.version.id, name, description, files: await currentFiles(files), compatibleAgents: detail.data?.record.compatibleAgents ?? ["novel-agent"], taskTypes: detail.data?.record.taskTypes ?? [], requiresSandbox: files.some((file) => file.path.startsWith("scripts/")) || Boolean(detail.data?.record.requiresSandbox), changeMessage: "编辑 Skill" });
  const refresh = async () => { setDirty(false); await Promise.all([client.invalidateQueries({ queryKey: ["skill", skillId] }), client.invalidateQueries({ queryKey: ["skill-versions", skillId] }), client.invalidateQueries({ queryKey: ["skills"] })]); };
  const save = useMutation({ mutationFn: async () => api.saveSkill(skillId, await draft()), onSuccess: refresh });
  const validate = useMutation({ mutationFn: () => api.validateSkill(skillId) });
  const test = useMutation({ mutationFn: (prompt: string) => api.testSkill(skillId, prompt) });
  const publish = useMutation({ mutationFn: () => api.publishSkill(skillId, detail.data!.version.id), onSuccess: refresh });
  const derive = useMutation({ mutationFn: () => api.deriveSkill(skillId), onSuccess: (result) => navigate("/skills/" + result.record.id) });
  const rollback = useMutation({ mutationFn: (versionId: string) => api.rollbackSkill(skillId, versionId), onSuccess: refresh });
  const archive = useMutation({ mutationFn: () => api.archiveSkill(skillId), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills"); } });
  const addText = async () => {
    const path = window.prompt("文件路径，例如 references/节奏.md 或 scripts/check.py");
    if (!path || files.some((file) => file.path === path)) return;
    const file = await textFile(path, path.startsWith("scripts/") ? "# 在隔离 Sandbox 中执行\n" : "# 参考资料\n", "text/plain");
    setFiles((current) => [...current, file]); setSelected(path); setDirty(true);
  };
  const upload = async (list: FileList) => { const next = await Promise.all([...list].map((file) => browserFile(file, "assets/" + file.name))); setFiles((current) => [...current.filter((file) => !next.some((item) => item.path === file.path)), ...next]); setDirty(true); };
  if (detail.isLoading) return <div className="skill-loading"><LoaderCircle className="spin" />正在打开 Skill…</div>;
  if (!detail.data) return <main className="skill-loading">无法打开 Skill：{detail.error?.message}</main>;
  const readonly = detail.data.record.official;
  return <main className="skill-editor-page">
    <header className="skill-editor-topbar"><Link to="/skills"><ArrowLeft />技能库</Link><div><span className={readonly ? "official" : ""}>{sourceLabel(detail.data.record)}</span><strong>{detail.data.record.name}</strong><small>v{detail.data.version.versionNumber} · {detail.data.record.status === "published" ? "已发布" : detail.data.record.status === "archived" ? "已归档" : "草稿"}</small></div><div>{readonly ? <button onClick={() => derive.mutate()}><Copy />派生并编辑</button> : <><button className="quiet-action" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Save />}保存草稿</button><button className="quiet-action" onClick={() => validate.mutate()}><Check />校验</button><button disabled={dirty || publish.isPending} onClick={() => publish.mutate()}><Upload />发布</button><button className="quiet-action" disabled={archive.isPending} onClick={() => window.confirm("归档后作品将不能继续启用这个 Skill，确定吗？") && archive.mutate()}>归档</button></>}</div></header>
    <section className="skill-editor-layout">
      <aside className="skill-file-tree"><header><strong>文件</strong>{!readonly && <div><button title="新建文本文件" onClick={addText}><FilePlus /></button><label title="上传资产"><PackageOpen /><input type="file" multiple onChange={(event) => event.currentTarget.files?.length && upload(event.currentTarget.files)} /></label></div>}</header>{files.map((file) => <button className={selected === file.path ? "active" : ""} onClick={() => setSelected(file.path)} key={file.path}><FileCode /><span>{file.path}</span><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small></button>)}</aside>
      <section className="skill-code-editor"><header><span>{selected}</span>{selectedFile?.kind === "binary" && <small>二进制资产支持预览、替换和下载</small>}</header>{selectedFile?.kind === "text" ? <textarea readOnly={readonly} value={selectedFile.content ?? ""} spellCheck={false} onChange={(event) => { const content = event.target.value; setFiles((current) => current.map((file) => file.path === selected ? { ...file, content } : file)); setDirty(true); }} /> : selectedFile ? <BinaryAsset file={selectedFile} readonly={readonly} onReplace={(file) => { setFiles((current) => current.map((item) => item.path === selected ? file : item)); setDirty(true); }} /> : null}</section>
      <aside className="skill-inspector"><section><small>基本信息</small><label>名称<input readOnly={readonly} value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} /></label><label>触发说明<textarea readOnly={readonly} value={description} onChange={(event) => { setDescription(event.target.value); setDirty(true); }} /></label></section><section><small>运行能力</small><p>{files.some((file) => file.path.startsWith("scripts/")) ? "包含脚本" : "纯指令 Skill"}</p><p className={sandbox.data?.configured ? "ok-text" : "warning-text"}>{sandbox.data?.configured ? "隔离 Sandbox 可用" : sandbox.data?.reason}</p><button disabled={test.isPending || (files.some((file) => file.path.startsWith("scripts/")) && !sandbox.data?.configured)} onClick={() => { const prompt = window.prompt("输入一个真实任务来试运行这个 Skill"); if (prompt) test.mutate(prompt); }}>{test.isPending ? <LoaderCircle className="spin" /> : <Play />}试运行</button>{test.data && <div className="skill-test-result"><strong>{test.data.elapsedMs} ms</strong><p>{test.data.output}</p></div>}</section>{validate.data && <section><small>校验结果</small><strong className={validate.data.valid ? "ok-text" : "warning-text"}>{validate.data.valid ? "可以发布" : "需要修复"}</strong>{[...validate.data.errors, ...validate.data.warnings].map((item, index) => <p key={item.code + index}>{item.path ? item.path + " · " : ""}{item.message}</p>)}</section>}<section><small>版本历史</small>{versions.data?.versions.map((version) => <div className="skill-version" key={version.id}><span>v{version.versionNumber}<small>{new Date(version.createdAt).toLocaleString()}</small></span>{!readonly && version.id !== detail.data.record.activeVersionId && <button disabled={rollback.isPending} onClick={() => rollback.mutate(version.id)}><RotateCcw />回滚</button>}</div>)}</section></aside>
    </section>
    {(save.error || validate.error || test.error || publish.error || derive.error || rollback.error || archive.error) && <p className="skill-error floating">{(save.error ?? validate.error ?? test.error ?? publish.error ?? derive.error ?? rollback.error ?? archive.error)?.message}</p>}
  </main>;
}

function BinaryAsset({ file, readonly, onReplace }: { file: SkillFileView; readonly: boolean; onReplace: (file: SkillFileView) => void }) {
  const dataUrl = file.base64 ? `data:${file.mimeType || "application/octet-stream"};base64,${file.base64}` : undefined;
  return <div className="skill-binary"><PackageOpen /><strong>{file.path}</strong><span>{file.mimeType ?? "binary"} · {file.size} bytes</span>{dataUrl && file.mimeType?.startsWith("image/") && <img src={dataUrl} alt={file.path} />}{dataUrl && <a className="button-like" href={dataUrl} download={file.path.split("/").at(-1) ?? "asset"}>下载资产</a>}{!readonly && <label className="button-like">替换<input type="file" onChange={async (event) => { const replacement = event.currentTarget.files?.[0]; if (!replacement) return; onReplace(await browserFile(replacement, file.path)); event.currentTarget.value = ""; }} /></label>}</div>;
}

export function NovelSkillBindings({ novelId }: { novelId: string }) {
  const client = useQueryClient();
  const library = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const current = useQuery({ queryKey: ["novel-skills", novelId], queryFn: () => api.novelSkills(novelId), enabled: Boolean(novelId) });
  const save = useMutation({
    mutationFn: (skill: SkillRecordView) => {
      const bindings: SkillBindingsView = current.data?.bindings ?? { version: 1, skills: [] };
      const existing = bindings.skills.find((item) => item.skillId === skill.id);
      const next = existing
        ? { ...bindings, skills: bindings.skills.map((item) => item.skillId === skill.id ? { ...item, enabled: !item.enabled } : item) }
        : { ...bindings, skills: [...bindings.skills, { skillId: skill.id, enabled: true, version: "latest" as const, agents: ["novel-agent"], tasks: [] }] };
      return api.saveNovelSkills(novelId, next, current.data!.file.sha256);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["novel-skills", novelId] }); },
  });
  const enabled = new Set(current.data?.bindings.skills.filter((item) => item.enabled).map((item) => item.skillId));
  const availableSkills = library.data?.skills.filter((skill) => skill.status === "published").sort((a, b) => (skillOrder.indexOf(a.id) === -1 ? 99 : skillOrder.indexOf(a.id)) - (skillOrder.indexOf(b.id) === -1 ? 99 : skillOrder.indexOf(b.id))) ?? [];
  return <section className="novel-skills"><header><span>创作方法</span><Link to="/skills">管理</Link></header>{availableSkills.map((skill) => { const info = skillInfo(skill); return <button className={enabled.has(skill.id) ? "enabled" : ""} disabled={!current.data || save.isPending} onClick={() => save.mutate(skill)} key={skill.id} title={`${info.label}：${info.description}`} aria-label={`${info.label} ${enabled.has(skill.id) ? "已启用" : "未启用"}`}><span><Sparkles /><strong>{info.label}</strong><small>{info.description}</small></span><em>{enabled.has(skill.id) ? "已启用" : "未启用"}</em></button>; })}</section>;
}
