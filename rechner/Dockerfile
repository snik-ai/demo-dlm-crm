# DLM Digital — Rechner & Konfiguratoren
# Serves static HTML files via nginx
# Deploy: rechner.dlm-digital.ch via Coolify

FROM nginx:alpine

COPY . /usr/share/nginx/html/

# Remove default nginx page
RUN rm -f /usr/share/nginx/html/50x.html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
