# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="40"> @data-fair/catalog-snowflake

Snowflake plugin for the Data Fair catalogs service.

The catalog browses databases, then schemas, then tables and views, and imports each table or view as a CSV file.
If the `database` field of the configuration is set, the catalog starts directly at the schemas of this database.

## Authentication

- **Key pair** (recommended): a PEM private key (PKCS#8, optionally encrypted with a passphrase) whose public key is registered on the Snowflake user (`ALTER USER ... SET RSA_PUBLIC_KEY = '...'`).
- **Password or programmatic access token**: Snowflake blocks password sign-ins for service users, and requires MFA for human users. A programmatic access token (PAT) can be entered in the password field instead.

The password, the private key and its passphrase are stored as catalog secrets and masked in the configuration.

The connection test checks that the warehouse (and the database, when set) is usable by the user's role.

## Notes

- Listing uses `SHOW` commands, which do not need a running warehouse, but return at most 10,000 objects. The search filters the results of the current list by name.
- Database, schema and table names are always quoted, so names with special characters are supported.
- Exports run `SELECT *` on the warehouse, with a 1 hour statement timeout (2 minutes for the listing queries). Rows are streamed to the CSV file.
- Values are written so that data-fair detects their types: dates as `YYYY-MM-DD`, `TIMESTAMP_LTZ`/`TIMESTAMP_TZ` as UTC instants, `TIMESTAMP_NTZ` without time zone (interpreted in the data-fair default time zone), `BINARY` in hexadecimal, `VARIANT`/`OBJECT`/`ARRAY` as JSON. Integers keep their full precision in the CSV file.
