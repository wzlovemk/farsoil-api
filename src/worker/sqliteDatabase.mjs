const transactionStatement=/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

class DurableStatement {
  constructor(sqlStorage,query){
    this.sqlStorage=sqlStorage;
    this.query=query;
  }
  get(...bindings){
    const cursor=this.sqlStorage.exec(this.query,...bindings);
    const result=cursor.next();
    return result.done?undefined:result.value;
  }
  all(...bindings){
    return this.sqlStorage.exec(this.query,...bindings).toArray();
  }
  run(...bindings){
    const cursor=this.sqlStorage.exec(this.query,...bindings);
    // Write statements do not yield rows, but fully consume the cursor to
    // make rowsWritten final and mirror node:sqlite's synchronous semantics.
    cursor.toArray();
    return {changes:cursor.rowsWritten,lastInsertRowid:0};
  }
}

export class DurableSqliteDatabase {
  constructor(storage){
    this.supportsSqlSavepoints=false;
    this.storage=storage;
    this.sql=storage.sql;
    this.activeTransaction=false;
    this.db={
      prepare:(query)=>new DurableStatement(this.sql,query),
      exec:(query)=>{
        if(transactionStatement.test(query))
          throw new Error("Transaction SQL is not supported by Durable Objects; use database.transaction()");
        this.sql.exec(query).toArray();
      }
    };
  }
  transaction(fn){
    if(this.activeTransaction)throw new Error("Nested server transaction is not supported");
    return this.storage.transactionSync(()=>{
      this.activeTransaction=true;
      try{return fn();}
      finally{this.activeTransaction=false;}
    });
  }
  assertInTransaction(){
    if(!this.activeTransaction)throw new Error("Server asset transaction required");
  }
  close(){}
}
