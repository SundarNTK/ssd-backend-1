# IP access control for the admin and POS sites

Only addresses on an allow list can open `admin.sivadurga.com` and `pos.sivadurga.com`. Customers keep using
`bookings.sivadurga.com`, and the API (`api.sivadurga.com`) stays open because customers, the NETS counters and the
bank's payment messages all call it. A System Admin manages the list in the browser: **Administration > Access Control**.

This is an extra gate in front of the sign-in, not a replacement for it. Everyone still has to sign in and hold the right role.

## How it works

1. A visit to the admin or POS site reaches **Nginx**.
2. Before passing it to the website app, Nginx asks the backend: `GET /api/v1/access/check` (Nginx `auth_request`).
3. The backend looks at the visitor's address and answers `200` (go on) or `403` (refuse). Nginx shows an
   "Access restricted" page for a `403`. Any other answer (backend down, database trouble) also refuses the visit:
   **it fails closed**.
4. The list and the mode are kept in memory for 30 seconds; every change on the screen applies immediately.
5. Every decision is also written to the **access history** (see below).

Whose address is checked: Nginx's check location sets `X-Forwarded-For` to the visitor's real connection address
(`$remote_addr`), **replacing** whatever the visitor sent. Headers such as `X-Forwarded-For`, `X-Real-IP` or `Forwarded`
sent by a visitor are never used.

### The three modes

| Mode | Effect |
|---|---|
| `off` (default), shown on the screen as **"Allow all addresses (no restriction)"** | The list is ignored and no address is blocked. The list is kept, so restricting again is one click. Deploying the feature changes nothing until this is changed. |
| `report` | Nobody is blocked. Visits that **would** be blocked are logged and shown on the screen. Use it to check the list is complete. |
| `enforce`, shown as **"Only the listed addresses"** | Only listed addresses (and the always-allowed ones) can open the admin and POS sites. |

### Access history

The screen's **Access history** table shows who opened, or tried to open, the admin and POS sites. It is stored in the
database (`ip_access_visits`), so it survives a restart of the server, and it is recorded in **every** mode, including
"allow all addresses".

- One row per **address, site, result and day** (Singapore time), with the first and last time it was seen. Opening one
  page asks the check route for dozens of files, so storing each one would be noise.
- Result: `Allowed`, `Would be blocked` (report-only mode) or `Blocked`.
- Written in the background, at most once a minute per address, site and result. If writing fails, the visit is still
  decided exactly the same way.
- Rows older than 365 days are removed automatically (a TTL index on `lastSeenAt`; the period is
  `IP_ACCESS_VISIT_RETENTION_DAYS` in `models/ip-access-visits`).
- The screen shows the latest 200 rows. Next to an address that is not on the list, **Add to list** copies it into the
  Add form.
- It records addresses of people who open the sites, including strangers who find them, so treat it as personal data.

### The way back in (cannot be locked out by the screen)

Order of precedence for every visit, strongest first:

1. `IP_ACCESS_FORCE_OFF=true` in `backend.env`: emergency switch, everyone is let in. Set it through Session Manager, then restart the backend.
2. `IP_ACCESS_ALWAYS_ALLOWED=1.2.3.4,5.6.7.0/29` in `backend.env`: always let in; cannot be removed from the screen. These two never touch the database, so they work even if it is down.
3. Mode `off`, then the saved list, then `report`, then `enforce` as above.

Safeguards in the screen's API:

- `enforce` is refused unless **your own address** is already allowed.
- While enforcing, you cannot remove the entry that keeps you in.
- Private addresses (192.168.x.x, 10.x.x.x and so on) are refused: visitors reach the server from the temple's **public** address, and typing the LAN address is the most likely mistake.
- Ranges wider than `/24` are refused; IPv6 is refused (the sites are reached over IPv4 only).
- Duplicates and a list longer than 100 entries are refused.
- Only the System Admin (SUPER_ADMIN user type) can use these routes, checked on the server as well as hidden in the menu.
- Every entry records who added it and when; every change is also written to the server log.

## Turning it on in production (in this order)

**Do these in order. The Nginx change before the backend is deployed would lock the admin and POS sites out.**

### 1. Deploy the backend and frontend as usual
Merge to `main`. The mode starts as `off`, so nothing changes yet.

### 2. Set the way back in
On the production server (Session Manager):
```
sudo nano /opt/ssd/backend.env
```
Add the temple's public address and your own (find them at https://checkip.amazonaws.com from each place):
```
IP_ACCESS_ALWAYS_ALLOWED=203.0.113.10,198.51.100.7
```
Then restart the backend so it reads it:
```
cd /opt/ssd
```
```
sudo docker compose up -d --force-recreate backend
```

### 3. Check the backend answers before touching Nginx
```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/api/v1/access/check
```
It must print `200` (the mode is off). If it prints `404`, the new backend is not deployed yet: stop here.

### 4. Put the Nginx include on the server
Back up first:
```
sudo cp /etc/nginx/conf.d/ssd.conf /opt/ssd/ssd.conf.bak3
```
Create the include file (the content is `docs/nginx/ssd-ipcheck.inc` in this repo):
```
sudo tee /etc/nginx/ssd-ipcheck.inc > /dev/null <<'EOF'
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
EOF
```

### 5. Add the include to the admin and POS HTTPS blocks only
Create the helper (it adds the line after `client_max_body_size 10m;` in those two blocks and nowhere else):
```
cat > /tmp/ipcheck.awk <<'EOF'
/^server[ \t]*\{/ { name="" }
/^[ \t]*server_name / { name=$2 }
{ print }
/client_max_body_size 10m;/ {
  if (name=="admin.sivadurga.com;" || name=="pos.sivadurga.com;") print "  include /etc/nginx/ssd-ipcheck.inc;"
}
EOF
```
Run it **once**:
```
awk -f /tmp/ipcheck.awk /etc/nginx/conf.d/ssd.conf > /tmp/ssd.ipcheck
```
```
grep -c "ssd-ipcheck.inc" /tmp/ssd.ipcheck
```
It must print `2`. (If an earlier `staff-ips.inc` rule was added, restore the backup first, so there is one rule, not two.) Then:
```
sudo cp /tmp/ssd.ipcheck /etc/nginx/conf.d/ssd.conf
```
```
sudo nginx -t
```
```
sudo systemctl reload nginx
```
With the mode `off`, the sites open exactly as before.

### 6. Fill the list and watch, from the admin screen
1. Sign in as the System Admin and open **Administration > Access Control**.
2. Add the temple's public address (and any other fixed location), each with a label.
3. Set the mode to **Report only**. Use the sites normally for a few days; the screen lists visits from addresses that are not on the list. Add any that should be allowed.
4. When the list is complete, set the mode to **Enforce**.

### 7. Test
- From a temple PC (listed): admin and POS open normally.
- From a phone on **mobile data** (not listed): both show "Access restricted".
- `bookings.sivadurga.com` opens for everyone. `https://api.sivadurga.com` is unchanged.
- `sudo certbot renew --dry-run` still succeeds.

### Undo
Immediately, without Nginx: set `IP_ACCESS_FORCE_OFF=true` in `backend.env` and restart the backend, or set the mode to **Off** on the screen.
Completely: `sudo cp /opt/ssd/ssd.conf.bak3 /etc/nginx/conf.d/ssd.conf`, then `sudo nginx -t` and `sudo systemctl reload nginx`.

For **UAT**, use the same steps with the `uat` hostnames: in the helper, use `uatadmin.sivadurga.com;` and `uatpos.sivadurga.com;`.

## How secure is it?

| Threat | Result |
|---|---|
| A stranger opens the admin or POS site | Refused with 403 before the app loads (including its scripts and images). They never see the sign-in page. |
| A visitor sends a fake `X-Forwarded-For`, `X-Real-IP` or `Forwarded` header claiming to be a listed address | Ignored: the address comes from the real connection. Tested against a real Nginx 1.28.3. |
| Someone calls the check route through `api.sivadurga.com` to learn the list | They can only learn about their own address (Nginx appends the real one; express reads that), and the route returns only a status code. |
| A non-admin user, or an unsigned request, edits the list | Refused 403 on the server; the menu entry is also hidden. |
| A System Admin locks everyone out by mistake | The screen's safeguards, the always-allowed addresses and the emergency switch. |
| The backend or database is down | The check fails closed for visitors without an override (admin and POS need the API to work anyway). The always-allowed addresses still get in. |
| A stolen System Admin account adds the attacker's address | Possible: this is what the sign-in protects. Every entry records who added it and when, and is logged. |
| Someone on an allowed network (a shared Wi-Fi, an infected temple PC) | Passes this gate and still has to sign in with a valid account and role. An IP list proves where a visit comes from, not who the person is. |
| IP spoofing from outside | Not practical for HTTPS: a visit needs a completed connection from the claimed address. |

What it does **not** do: it does not restrict the API, and it does not replace passwords, roles or two-step sign-in.
Admin actions through the API are still protected by sign-in and role checks.

## Known limits

- The temple needs a **fixed public IPv4 address**. If the provider changes it, staff are locked out until the list is updated (the always-allowed addresses and the emergency switch are the way back in).
- Devices on other networks (a counter display on mobile data, staff working from home) need their own fixed address on the list.
- If the backend is ever scaled to more than one copy, the 30-second cache is per copy (the saved list and the access history are shared in the database).
- The access history only fills when visits pass through Nginx on the server. On a developer machine nothing calls the check route, so it stays empty.
- The `/` page of each site redirects to `/admin` or `/pos` before the check runs (a redirect only; it reveals nothing).
