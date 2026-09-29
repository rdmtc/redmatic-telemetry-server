-- The live shape before the migrations: the 2019 schema plus cc and country, which were added by hand.

CREATE TABLE installation (
    uuid     VARCHAR (36)  UNIQUE
                           NOT NULL
                           PRIMARY KEY,
    redmatic VARCHAR (36),
    initial  VARCHAR (36),
    ccu      VARCHAR (36),
    platform VARCHAR (255),
    product  VARCHAR (255),
    created  DATETIME,
    updated  DATETIME,
    counter  DOUBLE,
    cc       VARCHAR (2),
    country  VARCHAR (255)
);

CREATE TABLE node (
    name              VARCHAR (255),
    version           VARCHAR (255),
    installation_uuid VARCHAR (36)  REFERENCES installation (uuid) ON DELETE CASCADE
);
