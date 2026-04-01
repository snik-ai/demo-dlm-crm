FROM nginx:alpine
COPY demo-generator/output /usr/share/nginx/html
COPY sales-infra/nginx/demos.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
