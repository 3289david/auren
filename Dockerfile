FROM node:22-alpine
WORKDIR /auren
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts
COPY networks ./networks
COPY website ./website
ENV AUREN_BIND=0.0.0.0
# RPC/P2P on 9650, faucet on 9690, website on 8080 (devnet mode); override CMD to run a single node.
EXPOSE 9650 9651 9652 9653 9690 8080
USER node
CMD ["node", "scripts/devnet.js", "--clean"]
