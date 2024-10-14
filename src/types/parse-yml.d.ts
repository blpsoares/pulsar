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
