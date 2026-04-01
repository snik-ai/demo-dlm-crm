FROM nginx:alpine
COPY demo-generator/output /usr/share/nginx/html
COPY nginx-demos-standalone.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
