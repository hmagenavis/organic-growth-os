# certs/

Public root certificates. **Nothing in this directory is a secret** — a root CA is
published precisely so it can be distributed — and nothing here is a private key.

## `supabase-prod-ca-2021.crt`

`Supabase Root 2021 CA`, the root that signs `*.pooler.supabase.com`. It is the
`sslrootcert` for every connection to the managed staging database, and it is what
turns `DATABASE_SSL_ROOT_CERT` (docs/cloud/ENVIRONMENT-MATRIX.md §2) into `verify-full`
rather than mere encryption.

| Field   | Value                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------- |
| Subject | `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA`                        |
| SHA-256 | `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA` |
| Serial  | `6CBC4CA1DEB63F692D0A2024C67289C2D13D54F6`                                                        |
| Valid   | 2021-04-28 → 2031-04-26                                                                           |

It expires in 2031. Replacing it is an ordinary commit: download the current root from
the dashboard (Project Settings → Database → SSL Configuration → _Download
certificate_), confirm the fingerprint above changes as expected, and replace the file.

Verify this copy against what the server actually presents:

```bash
openssl x509 -in certs/supabase-prod-ca-2021.crt -noout -fingerprint -sha256 -subject -serial
```
