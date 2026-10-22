# /etc/nginx/ssd-ipcheck.inc
#
# Included in the HTTPS server blocks of the ADMIN and POS sites only (not bookings, not api):
#
#     include /etc/nginx/ssd-ipcheck.inc;
#
# Before a visit reaches the app, Nginx asks the SSD backend "may this address in?" (auth_request).
# The backend answers from the allow list a System Admin keeps under Administration > Access Control:
#   200 = go on, 403 = refuse, anything else (backend down, database trouble) = refuse. It fails closed.
#
# The visitor's address is taken from the real connection ($remote_addr). X-Forwarded-For is OVERWRITTEN
# below, never appended to, so a visitor cannot claim to be someone else by sending that header.
# See docs/ip-access-control.md.
#
# This file is named .inc (not .conf) so Nginx never loads it on its own anywhere else.

auth_request /_ssd_ipcheck;
error_page 403 = @ssd_blocked;

location = /_ssd_ipcheck {
  internal;
  proxy_pass http://127.0.0.1:4000/api/v1/access/check;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Original-Host $host;
}

location @ssd_blocked {
  default_type text/html;
  return 403 '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access restricted</title></head><body style="font-family:sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#333"><h1 style="color:#7c1527">Access restricted</h1><p>This site opens only from approved locations. If you should have access, please contact the temple administrator.</p></body></html>';
}
