# Mongo Pulsar

### Temporary documentation for phase 1 use

#### What you need to have to run the project:

```sh
> Docker - docker-compose
```

#### Installation:

```sh
 > docker-compose up --build -d
```

#### Usage:

```sh
 > docker exec -it pulsar-app bash
```

#### The configuration file to indicate the dump execution settings is in the following format:

```yaml
command:
  dump:
    source:
      uri: ''
      db: ''
    destination:
      uri: ''
      db: ''
    collections: []
    queryString: '{"key":"value"}'
```

#### Their respective types are:

```Typescript
type DumpYmlOptions = {
  command: {
    dump: {
      source: {
        uri: string;
        db: string;
      };
      destination: {
        uri: string;
        db: string;
      };
      collections: string[];
      queryString: string;
    };
  };
};
```

#### Example of valid yaml

```yaml
command:
  dump:
    source:
      uri: 'mongodb://localhost:27017/'
      db: 'source-database'
    destination:
      uri: 'mongodb://localhost:27017/'
      db: 'destination-database' # Since we use mongorestore, the target database must already exist because mongorestore does not create a new database automatically (like mongoexport does, for example)
    collections: ['collection-1', 'collection-2']
    # OR
    # collections:
    # - "collection-1"
    # - 'collection-2'
    queryString: '{"key":"value"}' # The queryString must be sent in JSON.stringify format wrapped in single quotes.
```

#### After filling in the configuration yml file, you can run the following commands:

```sh
pulsar dump <config-file> -p 5
```

- pulsar: this is the name command
- dump: alias to use dump option
- config-file: filePath to your file with configurations to run dump
- -p OR --parallel: this flag allows you to define how many collections will be exported in parallel (without one depending on the other), by default this value is 2 if nothing is sent

#### Use example: <br>

`pulsar dump config.yml -p 5`

### Logs:

There are 2 types of logs configured for this application:

- Visual logs:
  - These logs are the ones that will appear on your terminal, indicating the phases and progress of the application
- Log records:
  - These logs will be stored within: src/logs/ in the files:

**error.log** -> stores only error logs

**debug.log** -> stores all types of logs, from the visual ones that appear on the terminal, such as informative logs, success logs, errors, etc.

<br>
<br>

---

##### In the full documentation I will also include the requirements for running the application outside of docker and how to install pulsar as a command on your machine.
