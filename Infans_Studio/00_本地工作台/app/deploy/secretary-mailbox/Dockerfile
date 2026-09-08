FROM node:22-alpine
WORKDIR /app
COPY server.mjs workbench-secretary-mailbox.mjs workbench-yingning-inbox.mjs vault-paths.mjs workbench-errors.mjs ./
USER 10001:10001
EXPOSE 8789
CMD ["node", "server.mjs"]
