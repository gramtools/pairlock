FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html site.webmanifest sw.js /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY vendor /usr/share/nginx/html/vendor
COPY icons /usr/share/nginx/html/icons
EXPOSE 80
