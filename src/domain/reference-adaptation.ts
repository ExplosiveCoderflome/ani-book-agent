import { z } from "zod";
import { evidenceSchema, transferableInsightSchema } from "./reference";

export const REFERENCE_DIMENSION_SYSTEMS = [
  { id: "character", label: "人物体系", from: 1, to: 12 },
  { id: "geography", label: "地理空间体系", from: 13, to: 22 },
  { id: "narrative", label: "时间叙事体系", from: 23, to: 37 },
  { id: "power", label: "器物战力体系", from: 38, to: 47 },
  { id: "worldview", label: "世界观底层体系", from: 48, to: 58 },
  { id: "expression", label: "精神表意体系", from: 59, to: 66 },
  { id: "form", label: "创作形式体系", from: 67, to: 70 },
] as const;

export const REFERENCE_DIMENSIONS = [
  ["01", "角色", "主角、配角、反派、路人、完整人物矩阵"],
  ["02", "人设", "性格、身世、执念、软肋、成长弧光"],
  ["03", "心理", "内心、创伤、欲望、潜意识、心魔"],
  ["04", "言行", "台词、口头禅、习惯、神态、肢体"],
  ["05", "外貌", "容貌、体型、服饰、标志性特征"],
  ["06", "身份", "职业、头衔、地位、隐藏身份"],
  ["07", "能力", "天赋、技能、功法、特长、短板"],
  ["08", "背景", "出身、家族、经历、教育、成长环境"],
  ["09", "关系", "社会关系网络、亲友、盟友、对手"],
  ["10", "羁绊", "宿命、血缘、契约、情感深绑定"],
  ["11", "族群/种族", "人族、妖族、神族、异族、亡灵"],
  ["12", "人物归宿", "结局、退场、归隐、陨落、重生"],
  ["13", "国家", "王朝、帝国、城邦、政权体系"],
  ["14", "势力", "门派、宗门、世家、财团、军阀"],
  ["15", "组织", "秘密结社、公会、教会、地下势力"],
  ["16", "场地", "具体剧情发生的物理场所"],
  ["17", "地点", "地标、坐标、标志性建筑"],
  ["18", "环境", "自然、社会、氛围、地貌、气候"],
  ["19", "场景", "剧情名场面、关键冲突、高光时刻"],
  ["20", "空间", "异次元、秘境、结界、位面"],
  ["21", "地缘", "地理格局、疆域、战略要道"],
  ["22", "遗迹", "古迹、废墟、遗址、失落之地"],
  ["23", "时间", "时刻、年代、纪元、时代背景"],
  ["24", "时间线", "整体时间轴、历史脉络、时序"],
  ["25", "事件", "历史、当前、关键节点事件"],
  ["26", "情节", "剧情段落、故事线、章节核心"],
  ["27", "线索", "主线、副线、暗线、伏笔线、道具"],
  ["28", "冲突", "内心、人际、阵营、宿命冲突"],
  ["29", "悬念", "钩子、谜题、谜团、悬念设置"],
  ["30", "转折", "反转、立场、局势、意外变故"],
  ["31", "叙事视角", "第一、第三、多视角、POV"],
  ["32", "叙事结构", "线性、倒叙、插叙、轮回、单元"],
  ["33", "叙事节奏", "张弛、留白、高潮配比"],
  ["34", "伏笔", "铺垫、暗线、前后呼应、填坑"],
  ["35", "彩蛋", "隐藏剧情、致敬、玩梗、细节"],
  ["36", "结局形态", "HE、BE、开放式、反转式"],
  ["37", "序幕/尾声", "开篇钩子、收束、番外、后日谈"],
  ["38", "道具", "日常、剧情、专属、功能性物品"],
  ["39", "武器", "冷兵器、热兵器、本命、制式、神兵"],
  ["40", "法器", "灵器、法宝、神器、符箓、丹药"],
  ["41", "战力体系", "修为、功法、异能、科技、规则"],
  ["42", "灵体/生灵", "精怪、鬼魂、幻兽、灵宠、魔物"],
  ["43", "异象", "天象、神迹、灾变、天地奇观"],
  ["44", "灾厄", "天灾、人祸、末日、诅咒、瘟疫"],
  ["45", "科技", "科技水平、黑科技、赛博、智能"],
  ["46", "资源", "天材地宝、灵脉、能源、矿产"],
  ["47", "载具", "坐骑、法器、飞船、机甲、战车"],
  ["48", "设定", "总纲、核心、题材、底层框架"],
  ["49", "规则", "世界法则、物理、天道、铁律"],
  ["50", "文明", "当前、史前、失落、发展脉络"],
  ["51", "律法", "国法、门规、江湖规矩、潜规则"],
  ["52", "信仰", "宗教、图腾、神明、教义、理念"],
  ["53", "货币体系", "经济、货币、物价、财富规则"],
  ["54", "宿命", "命运、因果、天命、既定轨迹"],
  ["55", "善恶观", "正邪、灰色地带、价值取向"],
  ["56", "历史", "世界史、民族史、秘史、野史"],
  ["57", "语言/文字", "通用语、古语、符文、密语"],
  ["58", "习俗/礼仪", "民俗、节日、祭祀、婚丧、礼仪"],
  ["59", "主题", "核心主旨、中心思想、表达内核"],
  ["60", "意象", "专属符号、具象元素、标志性事物"],
  ["61", "象征", "隐喻、寓言、深层含义、暗含表达"],
  ["62", "基调", "文风氛围、热血、悲凉、治愈、悬疑"],
  ["63", "情绪", "爆发点、共情、泪点、爽点、虐点"],
  ["64", "关联", "要素交叉、互文、对照、呼应"],
  ["65", "素材", "灵感、参考、原型、脑洞积累"],
  ["66", "笔记", "备忘、灵感碎片、待办、修改记录"],
  ["67", "文风", "古风、口语、冷峻、华丽、写实、诙谐"],
  ["68", "体裁", "长篇、短篇、连载、单元剧、剧本、轻小说"],
  ["69", "类型/流派", "玄幻、科幻、武侠、都市、言情、悬疑、灵异"],
  ["70", "视角人称", "第一、第二、第三人称、POV、全知视角"],
] as const;

export const referenceDimensionIdSchema = z.enum(REFERENCE_DIMENSIONS.map(([id]) => id));
export type ReferenceDimensionId = z.infer<typeof referenceDimensionIdSchema>;
export const referenceDimensionSystemIdSchema = z.enum(REFERENCE_DIMENSION_SYSTEMS.map(({ id }) => id));
export type ReferenceDimensionSystemId = z.infer<typeof referenceDimensionSystemIdSchema>;

export const referenceDimensionObservationSchema = z.object({
  dimensionId: referenceDimensionIdSchema,
  summary: z.string().trim().min(1).max(800),
  transferableMechanism: z.string().trim().min(1).max(1_000),
  score: z.number().min(0).max(5),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).min(1).max(4),
  insightId: z.string().trim().min(1).max(80).optional(),
});
export type ReferenceDimensionObservation = z.infer<typeof referenceDimensionObservationSchema>;

export const referenceStructureRadarSchema = z.object({
  schemaVersion: z.literal(1),
  systems: z.array(z.object({
    systemId: referenceDimensionSystemIdSchema,
    score: z.number().min(0).max(100).nullable(),
    coverage: z.number().min(0).max(1),
    observedDimensions: z.number().int().nonnegative(),
    totalDimensions: z.number().int().positive(),
  })).length(REFERENCE_DIMENSION_SYSTEMS.length),
  observations: z.array(referenceDimensionObservationSchema).max(70),
  recommendedInsightIds: z.array(z.string().trim().min(1).max(80)).max(3),
  generatedAt: z.string(),
}).superRefine((value, context) => {
  if (new Set(value.observations.map((item) => item.dimensionId)).size !== value.observations.length) context.addIssue({ code: "custom", path: ["observations"], message: "同一维度只能保留一条雷达观察" });
  if (new Set(value.recommendedInsightIds).size !== value.recommendedInsightIds.length) context.addIssue({ code: "custom", path: ["recommendedInsightIds"], message: "推荐洞察不可重复" });
  if (new Set(value.systems.map((item) => item.systemId)).size !== REFERENCE_DIMENSION_SYSTEMS.length) context.addIssue({ code: "custom", path: ["systems"], message: "雷达必须完整包含七个体系" });
});
export type ReferenceStructureRadar = z.infer<typeof referenceStructureRadarSchema>;

export function referenceDimensionSystem(dimensionId: ReferenceDimensionId): ReferenceDimensionSystemId {
  const numeric = Number(dimensionId);
  return REFERENCE_DIMENSION_SYSTEMS.find((item) => numeric >= item.from && numeric <= item.to)!.id;
}

export function buildReferenceStructureRadar(
  observations: ReferenceDimensionObservation[],
  recommendedInsightIds: string[],
  generatedAt = new Date().toISOString(),
): ReferenceStructureRadar {
  const unique = new Map<ReferenceDimensionId, ReferenceDimensionObservation>();
  for (const observation of observations) {
    const parsed = referenceDimensionObservationSchema.parse(observation);
    const prior = unique.get(parsed.dimensionId);
    if (!prior || parsed.confidence > prior.confidence) unique.set(parsed.dimensionId, parsed);
  }
  const values = [...unique.values()];
  const systems = REFERENCE_DIMENSION_SYSTEMS.map((system) => {
    const observed = values.filter((item) => referenceDimensionSystem(item.dimensionId) === system.id);
    const weight = observed.reduce((sum, item) => sum + item.confidence, 0);
    const score = weight ? Math.round(observed.reduce((sum, item) => sum + item.score * item.confidence, 0) / weight / 5 * 100) : null;
    const totalDimensions = system.to - system.from + 1;
    return { systemId: system.id, score, coverage: observed.length / totalDimensions, observedDimensions: observed.length, totalDimensions };
  });
  return referenceStructureRadarSchema.parse({ schemaVersion: 1, systems, observations: values, recommendedInsightIds: [...new Set(recommendedInsightIds)].slice(0, 3), generatedAt });
}

export const adaptationStatusSchema = z.enum(["proposed", "approved", "rejected", "stale"]);
export const adaptationPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  constraints: z.object({
    planning: z.array(z.string().trim().min(1).max(1_000)).max(12),
    writing: z.array(z.string().trim().min(1).max(1_000)).max(12),
    review: z.array(z.string().trim().min(1).max(1_000)).max(12),
  }),
});
export type AdaptationPlan = z.infer<typeof adaptationPlanSchema>;

export const referenceAdaptationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  novelId: z.string().uuid(),
  referenceId: z.string().uuid(),
  analysisId: z.string().min(1),
  analysisSha256: z.string().length(64),
  targetStateSha256: z.string().length(64),
  authorityFiles: z.record(z.string(), z.string().length(64)),
  selectedInsightIds: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
  selectedInsights: z.array(transferableInsightSchema.omit({ evidence: true })).min(1).max(3),
  scope: z.object({ fromChapter: z.number().int().positive(), toChapter: z.number().int().positive() }).refine((value) => value.toChapter >= value.fromChapter, { path: ["toChapter"], message: "结束章节不能早于开始章节" }),
  summary: adaptationPlanSchema.shape.summary,
  constraints: adaptationPlanSchema.shape.constraints,
  status: adaptationStatusSchema,
  staleReasons: z.array(z.enum(["analysis", "authority"])).default([]),
  approvedAt: z.string().optional(),
  rejectedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((value, context) => {
  if (new Set(value.selectedInsightIds).size !== value.selectedInsightIds.length) context.addIssue({ code: "custom", path: ["selectedInsightIds"], message: "洞察不可重复选择" });
  if (value.selectedInsights.some((item) => !value.selectedInsightIds.includes(item.id))) context.addIssue({ code: "custom", path: ["selectedInsights"], message: "提案洞察必须来自已选择的洞察 ID" });
});
export type ReferenceAdaptation = z.infer<typeof referenceAdaptationSchema>;

export function transitionAdaptation(adaptation: ReferenceAdaptation, action: "approve" | "reject", now = new Date().toISOString()): ReferenceAdaptation {
  if (adaptation.status !== "proposed") throw new Error("ADAPTATION_NOT_PROPOSED");
  return referenceAdaptationSchema.parse({ ...adaptation, status: action === "approve" ? "approved" : "rejected", ...(action === "approve" ? { approvedAt: now } : { rejectedAt: now }), updatedAt: now });
}
