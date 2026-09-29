--
-- File generated with SQLiteStudio v3.2.1 on Mo. Apr. 8 21:03:36 2019
--
-- Text encoding used: UTF-8
--
PRAGMA foreign_keys = off;
BEGIN TRANSACTION;

-- Table: installation
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
    counter  DOUBLE
);


-- Table: node
CREATE TABLE node (
    name              VARCHAR (255),
    version           VARCHAR (255),
    installation_uuid VARCHAR (36)  REFERENCES installation (uuid) ON DELETE CASCADE
);


COMMIT TRANSACTION;
PRAGMA foreign_keys = on;
