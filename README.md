# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="40"> @data-fair/catalog-snowflake

Snowflake plugin for the Data Fair catalogs service.

Le catalogue parcourt les bases de données, schémas puis tables/vues, et importe chaque table en CSV.
Si le champ `database` est renseigné dans la configuration, le catalogue démarre directement au niveau des schémas de cette base.

La recherche filtre les résultats de la liste courante par nom. Les identifiants sont systématiquement entre guillemets doubles, donc les bases, schémas et tables contenant des caractères spéciaux sont supportés. Les colonnes Snowflake sont mappées vers le schéma data-fair (nombres, booléens, dates, horodatages) au moment de l'import.
