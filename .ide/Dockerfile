# 云原生开发 / 在线预览环境镜像
# 仅用于「云原生开发」按钮启动预览，不影响生产构建
FROM node:20-bookworm

WORKDIR /workspace

# 国内构建机优先使用镜像源，加速依赖安装
RUN npm config set registry https://registry.npmmirror.com
