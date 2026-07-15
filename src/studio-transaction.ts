import type { StudioToolResult } from "./studio-client.js";
import { studioResultJson } from "./studio-client.js";
import { isStudioPath, studioPathDepth } from "./util.js";

export type StudioDataModelType = "Edit" | "Client" | "Server";

export interface StudioTypedValue {
  $type:
    | "nil"
    | "Enum"
    | "Vector2"
    | "Vector3"
    | "Color3"
    | "Color3RGB"
    | "CFrame"
    | "UDim"
    | "UDim2"
    | "BrickColor"
    | "NumberRange"
    | "Rect"
    | "InstancePath"
    | "NumberSequence"
    | "ColorSequence";
  value?: unknown;
  min?: number;
  max?: number;
  x?: unknown;
  y?: unknown;
  keypoints?: unknown[];
}

export type StudioValue =
  | null
  | boolean
  | number
  | string
  | StudioTypedValue
  | StudioValue[]
  | { [key: string]: StudioValue };

export interface CreateInstanceOperation {
  kind: "create";
  parent: string;
  className: string;
  name: string;
  properties?: Record<string, StudioValue>;
  attributes?: Record<string, StudioValue>;
  tags?: string[];
}

export interface SetPropertiesOperation {
  kind: "set-properties";
  target: string;
  properties: Record<string, StudioValue>;
}

export interface SetAttributesOperation {
  kind: "set-attributes";
  target: string;
  attributes: Record<string, StudioValue>;
}

export interface SetTagsOperation {
  kind: "set-tags";
  target: string;
  exact?: string[];
  add?: string[];
  remove?: string[];
}

export interface RenameInstanceOperation {
  kind: "rename";
  target: string;
  name: string;
}

export interface ReparentInstanceOperation {
  kind: "reparent";
  target: string;
  parent: string;
}

export interface DeleteInstanceOperation {
  kind: "delete";
  target: string;
}

export type StudioMutationOperation =
  | CreateInstanceOperation
  | SetPropertiesOperation
  | SetAttributesOperation
  | SetTagsOperation
  | RenameInstanceOperation
  | ReparentInstanceOperation
  | DeleteInstanceOperation;

export interface StudioTransactionPayload {
  marker: "pi-roblox-studio-transaction-v1";
  ok: boolean;
  checkpointId: string;
  error?: string;
  snapshot: StudioTransactionSnapshot;
  results?: unknown[];
}

export interface StudioTransactionSnapshot {
  marker: "pi-roblox-studio-snapshot-v1";
  checkpointId: string;
  operations: StudioSnapshotOperation[];
}

export type StudioSnapshotOperation = Record<string, unknown> & {
  kind: StudioMutationOperation["kind"];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENUM_VALUE = /^Enum\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

function assertStudioPath(value: string, label: string): void {
  if (!isStudioPath(value)) throw new Error(`${label} must be a game.* path: ${value}`);
}

function assertName(value: string, label: string): void {
  if (value.length === 0 || value.length > 100 || value.includes(".")) {
    throw new Error(`${label} must be 1-100 characters and cannot contain '.'.`);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is not a safe Roblox identifier: ${value}`);
}

function assertStringArray(value: string[] | undefined, label: string): void {
  if (!value) return;
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 200)) {
    throw new Error(`${label} contains an invalid string.`);
  }
}

function validateValue(value: StudioValue, depth = 0): void {
  if (depth > 20) throw new Error("Studio value nesting is too deep.");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Studio numeric values must be finite.");
  }
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) validateValue(entry, depth + 1);
    return;
  }
  if ("$type" in value) {
    const typed = value as StudioTypedValue;
    const allowed = new Set([
      "nil",
      "Enum",
      "Vector2",
      "Vector3",
      "Color3",
      "Color3RGB",
      "CFrame",
      "UDim",
      "UDim2",
      "BrickColor",
      "NumberRange",
      "Rect",
      "InstancePath",
      "NumberSequence",
      "ColorSequence"
    ]);
    if (!allowed.has(typed.$type)) throw new Error(`Unsupported Studio value type: ${typed.$type}`);
    if (typed.$type === "Enum" && (typeof typed.value !== "string" || !ENUM_VALUE.test(typed.value))) {
      throw new Error(`Invalid Enum value: ${String(typed.value)}`);
    }
    if (typed.$type === "InstancePath") {
      if (typeof typed.value !== "string") throw new Error("InstancePath value must be a string.");
      assertStudioPath(typed.value, "InstancePath");
    }
    return;
  }
  for (const entry of Object.values(value)) validateValue(entry, depth + 1);
}

function validateRecord(record: Record<string, StudioValue> | undefined, label: string): void {
  if (!record) return;
  for (const [key, value] of Object.entries(record)) {
    if (key.length === 0 || key.length > 200) throw new Error(`${label} contains an invalid key.`);
    validateValue(value);
  }
}

export function validateStudioOperations(operations: StudioMutationOperation[]): void {
  if (operations.length === 0) throw new Error("At least one Studio mutation operation is required.");
  if (operations.length > 100) throw new Error("A Studio transaction may contain at most 100 operations.");

  for (const [index, operation] of operations.entries()) {
    const prefix = `operations[${index}]`;
    switch (operation.kind) {
      case "create":
        assertStudioPath(operation.parent, `${prefix}.parent`);
        assertIdentifier(operation.className, `${prefix}.className`);
        assertName(operation.name, `${prefix}.name`);
        validateRecord(operation.properties, `${prefix}.properties`);
        validateRecord(operation.attributes, `${prefix}.attributes`);
        assertStringArray(operation.tags, `${prefix}.tags`);
        break;
      case "set-properties":
        assertStudioPath(operation.target, `${prefix}.target`);
        validateRecord(operation.properties, `${prefix}.properties`);
        for (const property of Object.keys(operation.properties)) {
          assertIdentifier(property, `${prefix}.properties key`);
          if (property === "Name" || property === "Parent") {
            throw new Error(`${prefix} must use rename/reparent rather than setting ${property}.`);
          }
        }
        break;
      case "set-attributes":
        assertStudioPath(operation.target, `${prefix}.target`);
        validateRecord(operation.attributes, `${prefix}.attributes`);
        break;
      case "set-tags":
        assertStudioPath(operation.target, `${prefix}.target`);
        assertStringArray(operation.exact, `${prefix}.exact`);
        assertStringArray(operation.add, `${prefix}.add`);
        assertStringArray(operation.remove, `${prefix}.remove`);
        if (operation.exact && (operation.add || operation.remove)) {
          throw new Error(`${prefix} cannot combine exact with add/remove.`);
        }
        break;
      case "rename":
        assertStudioPath(operation.target, `${prefix}.target`);
        if (studioPathDepth(operation.target) < 3) {
          throw new Error(`${prefix} cannot rename game or a top-level service.`);
        }
        assertName(operation.name, `${prefix}.name`);
        break;
      case "reparent":
        assertStudioPath(operation.target, `${prefix}.target`);
        assertStudioPath(operation.parent, `${prefix}.parent`);
        if (studioPathDepth(operation.target) < 3) {
          throw new Error(`${prefix} cannot reparent game or a top-level service.`);
        }
        break;
      case "delete":
        assertStudioPath(operation.target, `${prefix}.target`);
        if (studioPathDepth(operation.target) < 3) {
          throw new Error(`${prefix} cannot delete game or a top-level service.`);
        }
        break;
      default:
        throw new Error(`Unsupported Studio operation: ${String((operation as { kind?: unknown }).kind)}`);
    }
  }
}

function luaString(value: string): string {
  let output = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") output += "\\\\";
    else if (char === '"') output += '\\"';
    else if (char === "\n") output += "\\n";
    else if (char === "\r") output += "\\r";
    else if (char === "\t") output += "\\t";
    else if (code < 32 || code === 127) output += `\\${code.toString().padStart(3, "0")}`;
    else output += char;
  }
  return `${output}"`;
}

function numericArray(value: unknown, length: number | number[], label: string): number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`${label} must be an array of finite numbers.`);
  }
  const allowed = Array.isArray(length) ? length : [length];
  if (!allowed.includes(value.length)) {
    throw new Error(`${label} must contain ${allowed.join(" or ")} numbers.`);
  }
  return value;
}

export function studioValueToLuau(value: StudioValue): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Studio numeric values must be finite.");
    return String(value);
  }
  if (typeof value === "string") return luaString(value);
  if (Array.isArray(value)) return `{${value.map(studioValueToLuau).join(",")}}`;

  if ("$type" in value) {
    const typed = value as StudioTypedValue;
    switch (typed.$type) {
      case "nil":
        return "nil";
      case "Enum":
        if (typeof typed.value !== "string" || !ENUM_VALUE.test(typed.value)) {
          throw new Error(`Invalid Enum value: ${String(typed.value)}`);
        }
        return typed.value;
      case "Vector2": {
        const values = numericArray(typed.value, 2, "Vector2.value");
        return `Vector2.new(${values.join(",")})`;
      }
      case "Vector3": {
        const values = numericArray(typed.value, 3, "Vector3.value");
        return `Vector3.new(${values.join(",")})`;
      }
      case "Color3": {
        const values = numericArray(typed.value, 3, "Color3.value");
        return `Color3.new(${values.join(",")})`;
      }
      case "Color3RGB": {
        const values = numericArray(typed.value, 3, "Color3RGB.value");
        return `Color3.fromRGB(${values.join(",")})`;
      }
      case "CFrame": {
        const values = numericArray(typed.value, [3, 12], "CFrame.value");
        return `CFrame.new(${values.join(",")})`;
      }
      case "UDim": {
        const values = numericArray(typed.value, 2, "UDim.value");
        return `UDim.new(${values.join(",")})`;
      }
      case "UDim2": {
        const values = numericArray(typed.value, 4, "UDim2.value");
        return `UDim2.new(${values.join(",")})`;
      }
      case "BrickColor":
        if (typeof typed.value !== "string") throw new Error("BrickColor.value must be a string.");
        return `BrickColor.new(${luaString(typed.value)})`;
      case "NumberRange": {
        const min = typeof typed.min === "number" ? typed.min : undefined;
        const max = typeof typed.max === "number" ? typed.max : min;
        if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
          throw new Error("NumberRange requires finite min and max values.");
        }
        return `NumberRange.new(${min},${max})`;
      }
      case "Rect": {
        const values = numericArray(typed.value, 4, "Rect.value");
        return `Rect.new(${values.join(",")})`;
      }
      case "InstancePath":
        if (typeof typed.value !== "string") throw new Error("InstancePath.value must be a string.");
        assertStudioPath(typed.value, "InstancePath.value");
        return `resolvePath(${luaString(typed.value)})`;
      case "NumberSequence": {
        if (!Array.isArray(typed.keypoints)) throw new Error("NumberSequence.keypoints must be an array.");
        const points = typed.keypoints.map((entry) => {
          if (typeof entry !== "object" || entry === null) throw new Error("Invalid NumberSequence keypoint.");
          const record = entry as Record<string, unknown>;
          const time = Number(record.time);
          const pointValue = Number(record.value);
          const envelope = record.envelope === undefined ? 0 : Number(record.envelope);
          if (![time, pointValue, envelope].every(Number.isFinite)) {
            throw new Error("Invalid NumberSequence keypoint values.");
          }
          return `NumberSequenceKeypoint.new(${time},${pointValue},${envelope})`;
        });
        return `NumberSequence.new({${points.join(",")}})`;
      }
      case "ColorSequence": {
        if (!Array.isArray(typed.keypoints)) throw new Error("ColorSequence.keypoints must be an array.");
        const points = typed.keypoints.map((entry) => {
          if (typeof entry !== "object" || entry === null) throw new Error("Invalid ColorSequence keypoint.");
          const record = entry as Record<string, unknown>;
          const time = Number(record.time);
          if (!Number.isFinite(time)) throw new Error("Invalid ColorSequence keypoint time.");
          const color = record.color as StudioValue;
          return `ColorSequenceKeypoint.new(${time},${studioValueToLuau(color)})`;
        });
        return `ColorSequence.new({${points.join(",")}})`;
      }
    }
  }

  return `{${Object.entries(value)
    .map(([key, entry]) => `[${luaString(key)}]=${studioValueToLuau(entry)}`)
    .join(",")}}`;
}

function helpers(): string {
  return `
local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")

local function pathOf(instance)
    if instance == game then return "game" end
    local parts = {}
    local cursor = instance
    while cursor and cursor ~= game do
        table.insert(parts, 1, cursor.Name)
        cursor = cursor.Parent
    end
    if cursor ~= game then return nil end
    return "game." .. table.concat(parts, ".")
end

local function resolvePathOptional(path)
    if path == "game" then return game end
    if string.sub(path, 1, 5) ~= "game." then return nil end
    local cursor = game
    for segment in string.gmatch(string.sub(path, 6), "[^%.]+") do
        cursor = cursor:FindFirstChild(segment)
        if not cursor then return nil end
    end
    return cursor
end

local function resolvePath(path)
    local value = resolvePathOptional(path)
    if not value then error("Instance path not found: " .. tostring(path)) end
    return value
end

local function encodeValue(value)
    local kind = typeof(value)
    if kind == "nil" then return { ["$type"] = "nil" } end
    if kind == "boolean" or kind == "number" or kind == "string" then return value end
    if kind == "EnumItem" then return { ["$type"] = "Enum", value = tostring(value) } end
    if kind == "Vector2" then return { ["$type"] = "Vector2", value = { value.X, value.Y } } end
    if kind == "Vector3" then return { ["$type"] = "Vector3", value = { value.X, value.Y, value.Z } } end
    if kind == "Color3" then return { ["$type"] = "Color3", value = { value.R, value.G, value.B } } end
    if kind == "CFrame" then return { ["$type"] = "CFrame", value = { value:GetComponents() } } end
    if kind == "UDim" then return { ["$type"] = "UDim", value = { value.Scale, value.Offset } } end
    if kind == "UDim2" then return { ["$type"] = "UDim2", value = { value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset } } end
    if kind == "BrickColor" then return { ["$type"] = "BrickColor", value = value.Name } end
    if kind == "NumberRange" then return { ["$type"] = "NumberRange", min = value.Min, max = value.Max } end
    if kind == "Rect" then return { ["$type"] = "Rect", value = { value.Min.X, value.Min.Y, value.Max.X, value.Max.Y } } end
    if kind == "Instance" then return { ["$type"] = "InstancePath", value = pathOf(value) } end
    if kind == "NumberSequence" then
        local points = {}
        for _, point in ipairs(value.Keypoints) do
            table.insert(points, { time = point.Time, value = point.Value, envelope = point.Envelope })
        end
        return { ["$type"] = "NumberSequence", keypoints = points }
    end
    if kind == "ColorSequence" then
        local points = {}
        for _, point in ipairs(value.Keypoints) do
            table.insert(points, { time = point.Time, color = encodeValue(point.Value) })
        end
        return { ["$type"] = "ColorSequence", keypoints = points }
    end
    return { ["$type"] = "unsupported", kind = kind, value = tostring(value) }
end

local function restoreTags(instance, tags)
    for _, tag in ipairs(CollectionService:GetTags(instance)) do CollectionService:RemoveTag(instance, tag) end
    for _, tag in ipairs(tags) do CollectionService:AddTag(instance, tag) end
end

local function setProperty(instance, property, value)
    local ok, err = pcall(function() instance[property] = value end)
    if not ok then error("Could not set " .. pathOf(instance) .. "." .. property .. ": " .. tostring(err)) end
end
`;
}

function propertyAssignments(variable: string, values: Record<string, StudioValue> | undefined): string {
  if (!values) return "";
  return Object.entries(values)
    .map(([key, value]) => `setProperty(${variable}, ${luaString(key)}, ${studioValueToLuau(value)})`)
    .join("\n");
}

function attributeAssignments(variable: string, values: Record<string, StudioValue> | undefined): string {
  if (!values) return "";
  return Object.entries(values)
    .map(([key, value]) => `${variable}:SetAttribute(${luaString(key)}, ${studioValueToLuau(value)})`)
    .join("\n");
}

export function generateStudioTransactionLuau(
  checkpointId: string,
  operations: StudioMutationOperation[]
): string {
  validateStudioOperations(operations);
  const chunks: string[] = [helpers()];
  chunks.push(`
local checkpointId = ${luaString(checkpointId)}
local snapshot = { marker = "pi-roblox-studio-snapshot-v1", checkpointId = checkpointId, operations = {} }
local results = {}
local rollback = {}
local function addRollback(callback) table.insert(rollback, 1, callback) end
local function addSnapshot(value) table.insert(snapshot.operations, value) end
local function addResult(value) table.insert(results, value) end

local ok, err = pcall(function()
`);

  operations.forEach((operation, index) => {
    const id = `op${index + 1}`;
    switch (operation.kind) {
      case "create": {
        const createdPath = `${operation.parent}.${operation.name}`;
        chunks.push(`
    do
        local parent = resolvePath(${luaString(operation.parent)})
        if parent:FindFirstChild(${luaString(operation.name)}) then
            error("Create target already exists: ${createdPath}")
        end
        local instance = Instance.new(${luaString(operation.className)})
        instance.Name = ${luaString(operation.name)}
        ${propertyAssignments("instance", operation.properties)}
        ${attributeAssignments("instance", operation.attributes)}
        instance.Parent = parent
        ${[...new Set(operation.tags ?? [])]
          .map((tag) => `CollectionService:AddTag(instance, ${luaString(tag)})`)
          .join("\n        ")}
        local pathAfter = pathOf(instance)
        addRollback(function()
            local current = resolvePathOptional(pathAfter)
            if current then current:Destroy() end
        end)
        addSnapshot({ kind = "create", pathAfter = pathAfter, className = instance.ClassName })
        addResult({ kind = "create", path = pathAfter })
    end
`);
        break;
      }
      case "set-properties": {
        const captures = Object.keys(operation.properties)
          .map(
            (property, propertyIndex) =>
              `local old${propertyIndex} = instance[${luaString(property)}]\nbefore[${luaString(property)}] = encodeValue(old${propertyIndex})`
          )
          .join("\n        ");
        const restore = Object.keys(operation.properties)
          .map(
            (property, propertyIndex) =>
              `pcall(function() instance[${luaString(property)}] = old${propertyIndex} end)`
          )
          .join("\n            ");
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local pathBefore = pathOf(instance)
        local before = {}
        ${captures}
        addRollback(function()
            ${restore}
        end)
        ${propertyAssignments("instance", operation.properties)}
        local pathAfter = pathOf(instance)
        addSnapshot({ kind = "set-properties", pathBefore = pathBefore, pathAfter = pathAfter, properties = before })
        addResult({ kind = "set-properties", path = pathAfter })
    end
`);
        break;
      }
      case "set-attributes": {
        const captures = Object.keys(operation.attributes)
          .map(
            (attribute, attributeIndex) =>
              `local old${attributeIndex} = instance:GetAttribute(${luaString(attribute)})\nbefore[${luaString(attribute)}] = encodeValue(old${attributeIndex})`
          )
          .join("\n        ");
        const restore = Object.keys(operation.attributes)
          .map(
            (attribute, attributeIndex) =>
              `pcall(function() instance:SetAttribute(${luaString(attribute)}, old${attributeIndex}) end)`
          )
          .join("\n            ");
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local pathBefore = pathOf(instance)
        local before = {}
        ${captures}
        addRollback(function()
            ${restore}
        end)
        ${attributeAssignments("instance", operation.attributes)}
        addSnapshot({ kind = "set-attributes", pathBefore = pathBefore, pathAfter = pathOf(instance), attributes = before })
        addResult({ kind = "set-attributes", path = pathOf(instance) })
    end
`);
        break;
      }
      case "set-tags": {
        const exact = operation.exact
          ? `{${[...new Set(operation.exact)].map(luaString).join(",")}}`
          : undefined;
        const mutations = exact
          ? `restoreTags(instance, ${exact})`
          : [
              ...(operation.remove ?? []).map(
                (tag) => `CollectionService:RemoveTag(instance, ${luaString(tag)})`
              ),
              ...(operation.add ?? []).map(
                (tag) => `CollectionService:AddTag(instance, ${luaString(tag)})`
              )
            ].join("\n        ");
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local pathBefore = pathOf(instance)
        local before = CollectionService:GetTags(instance)
        addRollback(function() restoreTags(instance, before) end)
        ${mutations}
        addSnapshot({ kind = "set-tags", pathBefore = pathBefore, pathAfter = pathOf(instance), tags = before })
        addResult({ kind = "set-tags", path = pathOf(instance) })
    end
`);
        break;
      }
      case "rename":
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local pathBefore = pathOf(instance)
        local oldName = instance.Name
        addRollback(function() instance.Name = oldName end)
        instance.Name = ${luaString(operation.name)}
        local pathAfter = pathOf(instance)
        addSnapshot({ kind = "rename", pathBefore = pathBefore, pathAfter = pathAfter, oldName = oldName })
        addResult({ kind = "rename", path = pathAfter })
    end
`);
        break;
      case "reparent":
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local newParent = resolvePath(${luaString(operation.parent)})
        local pathBefore = pathOf(instance)
        local oldParent = instance.Parent
        local oldParentPath = pathOf(oldParent)
        addRollback(function() instance.Parent = oldParent end)
        instance.Parent = newParent
        local pathAfter = pathOf(instance)
        addSnapshot({ kind = "reparent", pathBefore = pathBefore, pathAfter = pathAfter, oldParentPath = oldParentPath })
        addResult({ kind = "reparent", path = pathAfter })
    end
`);
        break;
      case "delete":
        chunks.push(`
    do
        local instance = resolvePath(${luaString(operation.target)})
        local pathBefore = pathOf(instance)
        local oldParent = instance.Parent
        local oldParentPath = pathOf(oldParent)
        local oldName = instance.Name
        local serverStorage = game:GetService("ServerStorage")
        local root = serverStorage:FindFirstChild("__PiRobloxCheckpoints")
        if not root then
            root = Instance.new("Folder")
            root.Name = "__PiRobloxCheckpoints"
            root:SetAttribute("ManagedBy", "pi-roblox")
            root.Parent = serverStorage
        end
        local folder = root:FindFirstChild(checkpointId)
        if not folder then
            folder = Instance.new("Folder")
            folder.Name = checkpointId
            folder.Parent = root
        end
        local wasArchivable = instance.Archivable
        instance.Archivable = true
        local backup = instance:Clone()
        instance.Archivable = wasArchivable
        backup.Name = ${luaString(id)}
        backup:SetAttribute("PiRobloxOriginalName", oldName)
        backup.Parent = folder
        local backupPath = pathOf(backup)
        addRollback(function()
            if not resolvePathOptional(pathBefore) and backup.Parent then
                backup.Name = oldName
                backup.Parent = oldParent
            end
        end)
        instance:Destroy()
        addSnapshot({ kind = "delete", pathBefore = pathBefore, parentPath = oldParentPath, oldName = oldName, backupPath = backupPath })
        addResult({ kind = "delete", path = pathBefore, backupPath = backupPath })
    end
`);
        break;
    }
  });

  chunks.push(`
end)

if not ok then
    for _, callback in ipairs(rollback) do pcall(callback) end
    return HttpService:JSONEncode({
        marker = "pi-roblox-studio-transaction-v1",
        ok = false,
        checkpointId = checkpointId,
        error = tostring(err),
        snapshot = snapshot,
        results = results
    })
end

return HttpService:JSONEncode({
    marker = "pi-roblox-studio-transaction-v1",
    ok = true,
    checkpointId = checkpointId,
    snapshot = snapshot,
    results = results
})
`);

  return chunks.join("\n");
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function snapshotValueToLuau(value: unknown): string {
  return studioValueToLuau(value as StudioValue);
}

export function generateStudioRollbackLuau(snapshot: StudioTransactionSnapshot): string {
  if (snapshot.marker !== "pi-roblox-studio-snapshot-v1" || !Array.isArray(snapshot.operations)) {
    throw new Error("Invalid Studio transaction snapshot.");
  }

  const chunks = [helpers()];
  chunks.push(`
local HttpService = game:GetService("HttpService")
local results = {}
local failures = {}
local function result(kind, path) table.insert(results, { kind = kind, path = path }) end
local function failure(kind, path, err) table.insert(failures, { kind = kind, path = path, error = tostring(err) }) end
`);

  for (const raw of [...snapshot.operations].reverse()) {
    const operation = objectRecord(raw, "snapshot operation");
    const kind = String(operation.kind);
    const pathAfter = typeof operation.pathAfter === "string" ? operation.pathAfter : undefined;
    const pathBefore = typeof operation.pathBefore === "string" ? operation.pathBefore : undefined;
    const lookup = pathAfter ?? pathBefore;

    if (kind === "create" && pathAfter) {
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePathOptional(${luaString(pathAfter)})
        if instance then instance:Destroy() end
        result("create", ${luaString(pathAfter)})
    end)
    if not ok then failure("create", ${luaString(pathAfter)}, err) end
end
`);
      continue;
    }

    if (kind === "set-properties" && lookup) {
      const properties = objectRecord(operation.properties, "snapshot properties");
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePath(${luaString(lookup)})
        ${Object.entries(properties)
          .map(([property, value]) => `setProperty(instance, ${luaString(property)}, ${snapshotValueToLuau(value)})`)
          .join("\n        ")}
        result("set-properties", pathOf(instance))
    end)
    if not ok then failure("set-properties", ${luaString(lookup)}, err) end
end
`);
      continue;
    }

    if (kind === "set-attributes" && lookup) {
      const attributes = objectRecord(operation.attributes, "snapshot attributes");
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePath(${luaString(lookup)})
        ${Object.entries(attributes)
          .map(([attribute, value]) => `instance:SetAttribute(${luaString(attribute)}, ${snapshotValueToLuau(value)})`)
          .join("\n        ")}
        result("set-attributes", pathOf(instance))
    end)
    if not ok then failure("set-attributes", ${luaString(lookup)}, err) end
end
`);
      continue;
    }

    if (kind === "set-tags" && lookup) {
      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((value): value is string => typeof value === "string")
        : [];
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePath(${luaString(lookup)})
        restoreTags(instance, {${tags.map(luaString).join(",")}})
        result("set-tags", pathOf(instance))
    end)
    if not ok then failure("set-tags", ${luaString(lookup)}, err) end
end
`);
      continue;
    }

    if (kind === "rename" && pathAfter && typeof operation.oldName === "string") {
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePath(${luaString(pathAfter)})
        instance.Name = ${luaString(operation.oldName)}
        result("rename", pathOf(instance))
    end)
    if not ok then failure("rename", ${luaString(pathAfter)}, err) end
end
`);
      continue;
    }

    if (kind === "reparent" && pathAfter && typeof operation.oldParentPath === "string") {
      chunks.push(`
do
    local ok, err = pcall(function()
        local instance = resolvePath(${luaString(pathAfter)})
        instance.Parent = resolvePath(${luaString(operation.oldParentPath)})
        result("reparent", pathOf(instance))
    end)
    if not ok then failure("reparent", ${luaString(pathAfter)}, err) end
end
`);
      continue;
    }

    if (
      kind === "delete" &&
      typeof operation.backupPath === "string" &&
      typeof operation.parentPath === "string" &&
      typeof operation.oldName === "string"
    ) {
      chunks.push(`
do
    local ok, err = pcall(function()
        local backup = resolvePath(${luaString(operation.backupPath)})
        backup.Name = ${luaString(operation.oldName)}
        backup:SetAttribute("PiRobloxOriginalName", nil)
        backup.Parent = resolvePath(${luaString(operation.parentPath)})
        result("delete", pathOf(backup))
    end)
    if not ok then failure("delete", ${luaString(operation.backupPath)}, err) end
end
`);
      continue;
    }
  }

  chunks.push(`
return HttpService:JSONEncode({
    marker = "pi-roblox-studio-rollback-v1",
    ok = #failures == 0,
    checkpointId = ${luaString(snapshot.checkpointId)},
    results = results,
    failures = failures
})
`);
  return chunks.join("\n");
}

export function parseStudioTransactionResult(result: StudioToolResult): StudioTransactionPayload {
  const payload = studioResultJson<StudioTransactionPayload>(
    result,
    (value): value is StudioTransactionPayload =>
      typeof value === "object" &&
      value !== null &&
      (value as { marker?: unknown }).marker === "pi-roblox-studio-transaction-v1"
  );
  if (!payload) throw new Error("Studio transaction did not return a parseable pi-roblox payload.");
  if (!payload.ok) throw new Error(payload.error ?? "Studio transaction failed and was rolled back.");
  return payload;
}
