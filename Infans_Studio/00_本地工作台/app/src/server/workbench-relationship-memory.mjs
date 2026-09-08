import { WorkbenchWriteError } from "./workbench-errors.mjs";

export function createRelationshipMemoryService() {
  const excluded = async () => {
    throw new WorkbenchWriteError("私人关系记忆不在公开范围", 404, "RELATIONSHIP_EXCLUDED");
  };
  return {
    read: async () => ({ items: [], excluded: true }),
    write: excluded,
    preview: excluded,
    commit: excluded,
  };
}
