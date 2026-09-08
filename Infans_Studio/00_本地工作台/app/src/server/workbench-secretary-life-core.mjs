export function createSecretaryLifeCoreService() {
  return {
    read: async () => ({ available: false, excluded: true }),
    write: async () => { throw Object.assign(new Error("生命核心不在公开范围"), { status: 404 }); },
  };
}
