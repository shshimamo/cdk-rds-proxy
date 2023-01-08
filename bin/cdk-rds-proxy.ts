#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkRdsProxyStack } from '../lib/cdk-rds-proxy-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { Context } from '../lib/common/context'

const app = new cdk.App();
const cdkRdsProxy = new CdkRdsProxyStack(app, `${Context.ID_PREFIX}-CdkRdsProxyStack`, {
    env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
});

new LambdaStack(app, `${Context.ID_PREFIX}-LambdaStack`, {
    env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
    vpc: cdkRdsProxy.vpc,
    lambdaToRDSProxyGroup: cdkRdsProxy.lambdaToRDSProxyGroup,
    proxy: cdkRdsProxy.proxy,
    databaseCredentialsSecret: cdkRdsProxy.databaseCredentialsSecret,
})