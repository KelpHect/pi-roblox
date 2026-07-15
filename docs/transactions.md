# Transactions and rollback

## Filesystem operations

`roblox_files` accepts up to 200 operations in one transaction.

### Write

```json
{
  "kind": "write",
  "target": "src/server/Main.server.luau",
  "content": "print('hello')\n",
  "expectedSha256": "CURRENT_HASH"
}
```

Use `null` for `expectedSha256` when creating a file and requiring that it not already exist.

### Delete

```json
{
  "kind": "delete",
  "target": "src/shared/Obsolete.luau",
  "expectedSha256": "CURRENT_HASH"
}
```

### Move

```json
{
  "kind": "move",
  "from": "src/shared/Old.luau",
  "to": "src/shared/New.luau",
  "expectedSha256": "CURRENT_HASH",
  "overwrite": false
}
```

A dry-run resolves ownership, paths, and hashes without creating a checkpoint or changing source.

## Validation behavior

A transaction can run a named validation profile. When `autoRollbackOnValidationFailure` is true, the package restores the checkpoint after a failing validation run. It defaults to false so failed code remains available for Pi and the user to inspect. Apply failures default to automatic rollback.

## Sync evidence

Mapped writes are polled through Studio's script-reading capability. Evidence statuses include:

```text
verified       Studio source equals the normalized file contents
unverified     Studio was reachable but did not converge before timeout
not-connected  no Studio connection was available
not-mapped     the file has no Studio mapping
```

`unverified` is not proof of failure, but it is also not proof that the running place contains the change.

## Structured Studio operations

### Create

```json
{
  "kind": "create",
  "parent": "game.Workspace.Runtime",
  "className": "Folder",
  "name": "Generated",
  "attributes": { "Version": 1 },
  "tags": ["Generated"]
}
```

### Properties and attributes

```json
{
  "kind": "set-properties",
  "target": "game.Workspace.Runtime.Spawn",
  "properties": {
    "Anchored": true,
    "Position": { "$type": "Vector3", "value": [0, 5, 0] },
    "Material": { "$type": "Enum", "value": "Enum.Material.Neon" }
  }
}
```

```json
{
  "kind": "set-attributes",
  "target": "game.Workspace.Runtime.Spawn",
  "attributes": {
    "Owner": "system",
    "Temporary": { "$type": "nil" }
  }
}
```

### Tags

Use either an exact list or add/remove deltas:

```json
{
  "kind": "set-tags",
  "target": "game.Workspace.Runtime.Spawn",
  "add": ["Interactive"],
  "remove": ["Disabled"]
}
```

### Rename, reparent, and delete

```json
{ "kind": "rename", "target": "game.Workspace.Runtime.Old", "name": "New" }
```

```json
{
  "kind": "reparent",
  "target": "game.Workspace.Runtime.New",
  "parent": "game.ReplicatedStorage.Runtime"
}
```

```json
{ "kind": "delete", "target": "game.Workspace.Runtime.New" }
```

Game and top-level services cannot be renamed, reparented, or deleted.

## Typed values

A typed value is a JSON object with `$type`. Examples:

```json
{ "$type": "Vector2", "value": [10, 20] }
{ "$type": "Vector3", "value": [1, 2, 3] }
{ "$type": "Color3", "value": [0.1, 0.5, 1] }
{ "$type": "Color3RGB", "value": [26, 128, 255] }
{ "$type": "CFrame", "value": [0, 5, 0] }
{ "$type": "UDim", "value": [0.5, -10] }
{ "$type": "UDim2", "value": [0.5, -10, 1, -20] }
{ "$type": "BrickColor", "value": "Bright red" }
{ "$type": "NumberRange", "min": 1, "max": 5 }
{ "$type": "Rect", "value": [0, 0, 100, 50] }
{ "$type": "InstancePath", "value": "game.Workspace.Target" }
{ "$type": "Enum", "value": "Enum.Material.SmoothPlastic" }
```

Sequence keypoints are represented as JSON arrays under `keypoints`; the serializer validates their numeric content before generating Luau.

## Rollback conflicts

Normal file rollback requires the current state to equal the checkpoint's recorded post-mutation state. This prevents a rollback from deleting or overwriting newer work. A `force` restore bypasses this check and should be used only after manual review.
